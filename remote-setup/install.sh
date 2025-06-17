#!/bin/bash
set -e

echo "🔧 Checking and installing prerequisites..."

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

echo "📋 Updating package list..."
sudo apt-get update -y

if ! command_exists curl; then
    echo "📥 Installing curl..."
    sudo apt-get install -y curl
    if ! command_exists curl; then
        sudo apt install -y curl
    fi
else
    echo "✅ curl already installed"
fi

if ! command_exists wget; then
    echo "📥 Installing wget..."
    sudo apt-get install -y wget
else
    echo "✅ wget already installed"
fi

if ! command_exists curl; then
    echo "❌ curl installation failed, cannot continue"
    exit 1
fi

echo "🐳 Installing Docker..."
curl -fsSL https://get.docker.com -o get-docker.sh
if [ ! -f "get-docker.sh" ]; then
    echo "❌ Failed to download Docker install script"
    exit 1
fi
sudo sh get-docker.sh
sudo usermod -aG docker $USER

echo "📦 Installing Node.js & PM2..."
if curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -; then
    sudo apt-get install -y nodejs
else
    echo "⚠️  NodeSource failed, trying alternative..."
    sudo apt-get install -y nodejs npm
fi

sudo npm install -g pm2

echo "🔌 Setting up WebSocket client..."
DEVICE_IP=$(hostname -I | awk '{print $1}')
if [ -z "$DEVICE_IP" ]; then
    DEVICE_IP=$(ip route get 1 | awk '{print $7}' | head -1)
fi
echo "📍 Detected device IP: $DEVICE_IP"

WS_CLIENT_DIR="/opt/docker-client"
sudo mkdir -p $WS_CLIENT_DIR

cat > /tmp/client.js << 'CLIENTEOF'
const WebSocket = require('ws');
const os = require('os');
const { exec } = require('child_process');

const SERVER_URL = 'ws://192.168.1.64:8080';

function getDeviceIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'unknown';
}

const DEVICE_IP = getDeviceIP();
let ws;
let reconnectInterval = 5000;

function getSystemInfo() {
    return new Promise((resolve) => {
        const info = {
            hostname: os.hostname(),
            deviceIP: DEVICE_IP,
            platform: os.platform(),
            arch: os.arch(),
            uptime: Math.floor(os.uptime()),
            totalMem: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 100) / 100,
            freeMem: Math.round(os.freemem() / 1024 / 1024 / 1024 * 100) / 100,
            cpus: os.cpus().length,
            cpuModel: (os.cpus()[0]?.model || 'Unknown').replace(/[\\r\\n\\t"]/g, ' ').substring(0, 100),
            loadAvg: os.loadavg(),
            timestamp: new Date().toISOString()
        };
        
        exec('df -h / | tail -1 | awk "{print $2,$3,$4,$5}"', (err, stdout) => {
            if (!err && stdout) {
                const parts = stdout.trim().split(' ');
                info.disk = { 
                    total: parts[0] || 'N/A', 
                    used: parts[1] || 'N/A', 
                    avail: parts[2] || 'N/A', 
                    usePercent: parts[3] || 'N/A'
                };
            }
            
            exec('docker --version 2>/dev/null', (err, stdout) => {
                info.dockerVersion = err ? 'Not installed' : (stdout || 'Unknown').trim().replace(/[\\r\\n\\t"]/g, ' ').substring(0, 50);
                
                exec('pm2 --version 2>/dev/null', (err, stdout) => {
                    info.pm2Version = err ? 'Not installed' : (stdout || 'Unknown').trim().replace(/[\\r\\n\\t"]/g, ' ').substring(0, 20);
                    
                    exec('uname -r', (err, stdout) => {
                        info.kernelVersion = err ? 'Unknown' : (stdout || 'Unknown').trim().replace(/[\\r\\n\\t"]/g, ' ').substring(0, 50);
                        resolve(info);
                    });
                });
            });
        });
    });
}

function connect() {
    console.log('🔌 Connecting to ' + SERVER_URL + '...');
    ws = new WebSocket(SERVER_URL);
    
    ws.on('open', async () => {
        console.log('✅ Connected! Device IP: ' + DEVICE_IP);
        reconnectInterval = 5000; // Reset reconnect interval on successful connection
        
        const systemInfo = await getSystemInfo();
        ws.send(JSON.stringify({
            type: 'device-info',
            ...systemInfo
        }));
        
        setInterval(async () => {
            if (ws.readyState === ws.OPEN) {
                const updateInfo = await getSystemInfo();
                ws.send(JSON.stringify({
                    type: 'device-update',
                    ...updateInfo
                }));
            }
        }, 30000);
    });
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'restart-command') {
                console.log('🔄 Restart command received');
                ws.send(JSON.stringify({
                    type: 'restart-ack',
                    deviceIP: DEVICE_IP,
                    hostname: os.hostname(),
                    timestamp: new Date().toISOString()
                }));
                
                setTimeout(() => {
                    console.log('🔄 Restarting system...');
                    exec('sudo reboot', (err) => {
                        if (err) console.log('❌ Restart failed:', err.message);
                    });
                }, 2000);
            }
            else if (data.type === 'terminal-command') {
                console.log('💻 Terminal command:', data.command);
                exec(data.command, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
                    ws.send(JSON.stringify({
                        type: 'terminal-response',
                        deviceIP: DEVICE_IP,
                        hostname: os.hostname(),
                        commandId: data.commandId,
                        command: data.command,
                        stdout: stdout,
                        stderr: stderr,
                        error: err ? err.message : null,
                        timestamp: new Date().toISOString()
                    }));
                });
            }
            else if (data.type === 'build-image') {
                console.log('🐳 Build image:', data.imageName);
                console.log('⚙️ Config:', data.config);
                
                const tempDir = '/tmp/docker-build-' + Date.now();
                const config = data.config || {};
                
                // Enhanced Dockerfile with configuration
                const dockerfileContent = [
                    'FROM ' + data.baseImage,
                    'RUN apt-get update && apt-get install -y curl wget git vim nano htop stress-ng && rm -rf /var/lib/apt/lists/*',
                    'WORKDIR /app',
                    'EXPOSE 80 3000 8080',
                    'CMD ["/bin/bash"]'
                ].join('\n');
                
                exec('mkdir -p ' + tempDir, (err) => {
                    if (err) {
                        ws.send(JSON.stringify({
                            type: 'build-response',
                            deviceIP: DEVICE_IP,
                            buildId: data.buildId,
                            imageName: data.imageName,
                            error: 'Failed to create build directory: ' + err.message,
                            success: false,
                            timestamp: new Date().toISOString()
                        }));
                        return;
                    }
                    
                    const fs = require('fs');
                    const dockerfilePath = tempDir + '/Dockerfile';
                    
                    try {
                        fs.writeFileSync(dockerfilePath, dockerfileContent);
                        console.log('📝 Dockerfile created successfully');
                        
                        // Build image
                        const buildCmd = 'cd ' + tempDir + ' && docker build -t ' + data.imageName + ' .';
                        console.log('🔨 Building image:', buildCmd);
                        
                        exec(buildCmd, { timeout: 300000, maxBuffer: 5 * 1024 * 1024 }, (buildErr, buildStdout, buildStderr) => {
                            if (buildErr) {
                                exec('rm -rf ' + tempDir, () => {});
                                ws.send(JSON.stringify({
                                    type: 'build-response',
                                    deviceIP: DEVICE_IP,
                                    buildId: data.buildId,
                                    imageName: data.imageName,
                                    stdout: buildStdout || '',
                                    stderr: buildStderr || '',
                                    error: buildErr.message,
                                    success: false,
                                    timestamp: new Date().toISOString()
                                }));
                                return;
                            }
                            
                            console.log('✅ Image built successfully, starting container...');
                            
                            // Run container with configuration
                            let runCmd = 'docker run -d';
                            if (config.ram) runCmd += ' --memory=' + config.ram + 'm';
                            if (config.cpu) runCmd += ' --cpus=' + config.cpu;
                            if (config.port) runCmd += ' -p ' + config.port;
                            if (config.network) runCmd += ' --network=' + config.network;
                            if (config.disk) runCmd += ' --tmpfs /tmp:size=' + config.disk + 'g';
                            runCmd += ' --name=' + data.imageName.replace(/[^a-zA-Z0-9]/g, '-') + '-' + Date.now();
                            runCmd += ' ' + data.imageName;
                            
                            console.log('🚀 Running container:', runCmd);
                            
                            exec(runCmd, { timeout: 60000 }, (runErr, runStdout, runStderr) => {
                                exec('rm -rf ' + tempDir, () => {});
                                
                                const containerOutput = runErr ? 
                                    '❌ Container start failed: ' + runErr.message :
                                    '✅ Container started: ' + (runStdout || '').trim();
                                
                                console.log('🐳 Container result:', runErr ? 'FAILED' : 'SUCCESS');
                                
                                ws.send(JSON.stringify({
                                    type: 'build-response',
                                    deviceIP: DEVICE_IP,
                                    buildId: data.buildId,
                                    imageName: data.imageName,
                                    baseImage: data.baseImage,
                                    config: config,
                                    stdout: (buildStdout || '') + '\n' + containerOutput + '\n' + (runStdout || ''),
                                    stderr: (buildStderr || '') + '\n' + (runStderr || ''),
                                    error: runErr ? runErr.message : null,
                                    success: !runErr,
                                    buildTime: new Date().toISOString(),
                                    timestamp: new Date().toISOString()
                                }));
                            });
                        });
                        
                    } catch (writeErr) {
                        ws.send(JSON.stringify({
                            type: 'build-response',
                            deviceIP: DEVICE_IP,
                            buildId: data.buildId,
                            imageName: data.imageName,
                            error: 'Failed to write Dockerfile: ' + writeErr.message,
                            success: false,
                            timestamp: new Date().toISOString()
                        }));
                    }
                });
            }
            
        } catch (e) {
            console.log('📨 Unknown message:', message);
        }
    });
    
    ws.on('close', () => {
        console.log('❌ Disconnected. Reconnecting in ' + (reconnectInterval/1000) + 's...');
        setTimeout(connect, reconnectInterval);
        reconnectInterval = Math.min(reconnectInterval * 1.5, 30000); // Max 30s
    });
    
    ws.on('error', (err) => {
        console.log('🔄 Connection error:', err.code || err.message);
        reconnectInterval = Math.min(reconnectInterval * 1.2, 15000); // Backoff on error
    });
}

connect();
CLIENTEOF

sudo mv /tmp/client.js $WS_CLIENT_DIR/client.js

cat > /tmp/package.json << 'PKGEOF'
{
  "name": "docker-websocket-client",
  "version": "1.0.0",
  "main": "client.js",
  "dependencies": {
    "ws": "^8.14.2"
  }
}
PKGEOF

sudo mv /tmp/package.json $WS_CLIENT_DIR/package.json

cd $WS_CLIENT_DIR
sudo npm install

echo "🚀 Starting PM2 service..."
sudo pm2 start client.js --name "docker-client"
sudo pm2 startup
sudo pm2 save

echo "🔐 Setting up sudo permissions..."
echo "root ALL=(ALL) NOPASSWD: /sbin/reboot" | sudo tee -a /etc/sudoers.d/docker-client-restart
sudo chmod 440 /etc/sudoers.d/docker-client-restart

echo "📤 Collecting device information..."
HOSTNAME=$(hostname)
KERNEL_VERSION=$(uname -r | tr -d '\n\r')
CPU_INFO=$(lscpu | grep "Model name" | cut -d ':' -f2 | xargs | sed 's/["]/_/g' | tr -d '\n\r' || echo "Unknown")
TOTAL_MEM=$(free -h | awk '/^Mem:/ {print $2}' | tr -d '\n\r')
DISK_INFO=$(df -h / | tail -1 | awk '{print $2","$3","$4","$5}' | tr -d '\n\r')
DOCKER_VERSION=$(docker --version 2>/dev/null | tr -d '\n\r' || echo "Installation in progress")
PM2_VERSION=$(pm2 --version 2>/dev/null | tr -d '\n\r' || echo "Installation in progress")
PLATFORM=$(uname -s | tr -d '\n\r')
ARCHITECTURE=$(uname -m | tr -d '\n\r')

clean_json_string() {
    echo "$1" | sed 's/["\\]/\\&/g' | tr -d '\n\r\t' | head -c 100
}

HOSTNAME_CLEAN=$(clean_json_string "$HOSTNAME")
CPU_INFO_CLEAN=$(clean_json_string "$CPU_INFO")
KERNEL_VERSION_CLEAN=$(clean_json_string "$KERNEL_VERSION")
DOCKER_VERSION_CLEAN=$(clean_json_string "$DOCKER_VERSION")
PM2_VERSION_CLEAN=$(clean_json_string "$PM2_VERSION")

JSON_PAYLOAD=$(cat << EOF
{
  "deviceIP": "$DEVICE_IP",
  "hostname": "$HOSTNAME_CLEAN",
  "status": "success",
  "installDate": "$(date -Iseconds)",
  "systemInfo": {
    "kernelVersion": "$KERNEL_VERSION_CLEAN",
    "cpuInfo": "$CPU_INFO_CLEAN",
    "totalMemory": "$TOTAL_MEM",
    "diskInfo": "$DISK_INFO",
    "dockerVersion": "$DOCKER_VERSION_CLEAN",
    "pm2Version": "$PM2_VERSION_CLEAN",
    "platform": "$PLATFORM",
    "architecture": "$ARCHITECTURE"
  }
}
EOF
)

echo "📤 Notifying server..."
curl -X POST http://192.168.1.64:8080/install-complete \
  -H "Content-Type: application/json" \
  -d "$JSON_PAYLOAD" \
  || echo "⚠️  Failed to notify server"

echo "✅ Setup complete!"
echo "📱 Device IP: $DEVICE_IP"
echo "🖥️  Hostname: $HOSTNAME_CLEAN"  
echo "🐳 Docker: $DOCKER_VERSION_CLEAN"
echo "🔄 WebSocket client running with PM2"
echo "🔍 Check status: sudo pm2 status"

rm -f get-docker.sh
