const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const http = require('http');
const config = require('./config');

// Device storage functions
function initDevicesDir() {
    if (!fs.existsSync(config.devicesDir)) {
        fs.mkdirSync(config.devicesDir, { recursive: true });
    }
}

function saveDevice(deviceIP, deviceInfo) {
    const deviceFile = path.join(config.devicesDir, `${deviceIP.replace(/\./g, '_')}.json`);
    const existingData = fs.existsSync(deviceFile) ? JSON.parse(fs.readFileSync(deviceFile, 'utf8')) : {};
    
    const deviceData = {
        ip: deviceIP,
        ...existingData,
        ...deviceInfo,
        lastSeen: new Date().toISOString(),
        status: deviceInfo.status || 'connected'
    };
    
    fs.writeFileSync(deviceFile, JSON.stringify(deviceData, null, 2));
    console.log(`💾 Device saved: ${deviceIP} (${deviceInfo.hostname || 'Unknown'})`);
}

function loadAllDevices() {
    const devices = new Map();
    if (!fs.existsSync(config.devicesDir)) return devices;
    
    const files = fs.readdirSync(config.devicesDir).filter(f => f.endsWith('.json'));
    files.forEach(file => {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(config.devicesDir, file), 'utf8'));
            devices.set(data.ip, data);
        } catch (e) {
            console.log(`❌ Error loading device file ${file}:`, e.message);
        }
    });
    
    console.log(`📚 Loaded ${devices.size} devices from storage`);
    return devices;
}

function getAllDevices() {
    return loadAllDevices();
}

// Find free port if needed
function findFreePort(startPort = 8080) {
    return new Promise((resolve) => {
        const server = require('net').createServer();
        server.listen(startPort, (err) => {
            if (err) {
                server.close();
                resolve(findFreePort(startPort + 1));
            } else {
                const port = server.address().port;
                server.close();
                resolve(port);
            }
        });
        server.on('error', () => {
            resolve(findFreePort(startPort + 1));
        });
    });
}

// Create client script with environment-aware configuration
function createClientScript() {
    const serverUrl = config.getWebSocketUrl();
    
    return `const WebSocket = require('ws');
const os = require('os');
const { exec } = require('child_process');

const SERVER_URL = '${serverUrl}';

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
            cpuModel: (os.cpus()[0]?.model || 'Unknown').replace(/[\\\\r\\\\n\\\\t"]/g, ' ').substring(0, 100),
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
                info.dockerVersion = err ? 'Not installed' : (stdout || 'Unknown').trim().replace(/[\\\\r\\\\n\\\\t"]/g, ' ').substring(0, 50);
                
                exec('pm2 --version 2>/dev/null', (err, stdout) => {
                    info.pm2Version = err ? 'Not installed' : (stdout || 'Unknown').trim().replace(/[\\\\r\\\\n\\\\t"]/g, ' ').substring(0, 20);
                    
                    exec('uname -r', (err, stdout) => {
                        info.kernelVersion = err ? 'Unknown' : (stdout || 'Unknown').trim().replace(/[\\\\r\\\\n\\\\t"]/g, ' ').substring(0, 50);
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
        reconnectInterval = 5000;
        
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
                
                const dockerfileContent = [
                    'FROM ' + data.baseImage,
                    'RUN apt-get update && apt-get install -y curl wget git vim nano htop stress-ng && rm -rf /var/lib/apt/lists/*',
                    'WORKDIR /app',
                    'EXPOSE 80 3000 8080',
                    'CMD ["/bin/bash"]'
                ].join('\\n');
                
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
                                    stdout: (buildStdout || '') + '\\n' + containerOutput + '\\n' + (runStdout || ''),
                                    stderr: (buildStderr || '') + '\\n' + (runStderr || ''),
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
        reconnectInterval = Math.min(reconnectInterval * 1.5, 30000);
    });
    
    ws.on('error', (err) => {
        console.log('🔄 Connection error:', err.code || err.message);
        reconnectInterval = Math.min(reconnectInterval * 1.2, 15000);
    });
}

connect();`;
}

// Create install script with environment-aware configuration
function createInstallScript() {
    const clientScript = createClientScript();
    const serverUrl = config.getServerUrl();
    
    return `#!/bin/bash
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
${clientScript}
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
KERNEL_VERSION=$(uname -r | tr -d '\\n\\r')
CPU_INFO=$(lscpu | grep "Model name" | cut -d ':' -f2 | xargs | sed 's/["]/_/g' | tr -d '\\n\\r' || echo "Unknown")
TOTAL_MEM=$(free -h | awk '/^Mem:/ {print $2}' | tr -d '\\n\\r')
DISK_INFO=$(df -h / | tail -1 | awk '{print $2","$3","$4","$5}' | tr -d '\\n\\r')
DOCKER_VERSION=$(docker --version 2>/dev/null | tr -d '\\n\\r' || echo "Installation in progress")
PM2_VERSION=$(pm2 --version 2>/dev/null | tr -d '\\n\\r' || echo "Installation in progress")
PLATFORM=$(uname -s | tr -d '\\n\\r')
ARCHITECTURE=$(uname -m | tr -d '\\n\\r')

clean_json_string() {
    echo "$1" | sed 's/["\\\\]/\\\\&/g' | tr -d '\\n\\r\\t' | head -c 100
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
curl -X POST ${serverUrl}/install-complete \\
  -H "Content-Type: application/json" \\
  -d "$JSON_PAYLOAD" \\
  || echo "⚠️  Failed to notify server"

echo "✅ Setup complete!"
echo "📱 Device IP: $DEVICE_IP"
echo "🖥️  Hostname: $HOSTNAME_CLEAN"  
echo "🐳 Docker: $DOCKER_VERSION_CLEAN"
echo "🔄 WebSocket client running with PM2"
echo "🔍 Check status: sudo pm2 status"

rm -f get-docker.sh
`;
}

// Create setup files
function createSetupFiles() {
    if (!fs.existsSync(config.setupDir)) {
        fs.mkdirSync(config.setupDir, { recursive: true });
    }
    
    const installScript = createInstallScript();
    fs.writeFileSync(path.join(config.setupDir, 'install.sh'), installScript);
    fs.chmodSync(path.join(config.setupDir, 'install.sh'), 0o755);
    
    console.log(`📁 Setup files created in ${config.setupDir}/ for ${config.getServerAddress()}`);
}

// Initialize server
async function init() {
    try {
        // Display current configuration
        config.display();
        
        // Auto-find port if in development and port is busy
        if (config.isDevelopment) {
            const freePort = await findFreePort(config.port);
            if (freePort !== config.port) {
                console.log(`⚠️  Port ${config.port} busy, using ${freePort}`);
                config.port = freePort;
            }
        }
        
        initDevicesDir();
        createSetupFiles();
        
        const savedDevices = loadAllDevices();
        const connectedDevices = new Map();
        
        // HTTP Server
        const server = http.createServer((req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            
            if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
                const indexPath = path.join(__dirname, 'index.html');
                if (fs.existsSync(indexPath)) {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(fs.readFileSync(indexPath));
                } else {
                    res.writeHead(404);
                    res.end('index.html not found');
                }
            }
            else if (req.method === 'GET' && req.url === '/api/connected') {
                const connected = {};
                connectedDevices.forEach((deviceInfo, key) => {
                    const info = deviceInfo.info || {};
                    if (info.deviceIP && info.deviceIP.includes('.')) {
                        connected[info.deviceIP] = {
                            deviceIP: info.deviceIP,
                            hostname: info.hostname,
                            status: 'connected',
                            connectTime: info.timestamp
                        };
                    }
                });
                console.log(`📡 API /api/connected called, returning ${Object.keys(connected).length} devices`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(connected));
            }
            else if (req.method === 'GET' && req.url === '/api/devices') {
                const devices = getAllDevices();
                const deviceArray = Array.from(devices.values());
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(deviceArray));
            }
            else if (req.method === 'GET' && req.url === '/install.sh') {
                const installScript = createInstallScript();
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(installScript);
            }
            else if (req.method === 'GET' && req.url === '/auto-install') {
                const autoScript = `#!/bin/bash
set -e

echo "🚀 Auto Docker Setup - One Command Install"

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
fi

if ! command_exists wget; then
    echo "📥 Installing wget..."
    sudo apt-get install -y wget
fi

if ! command_exists curl; then
    echo "❌ curl installation failed"
    exit 1
fi

echo "📥 Downloading main install script..."
curl -fsSL ${config.getInstallUrl()} | bash

echo "✅ Auto installation completed!"
`;
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(autoScript);
            }
            else if (req.method === 'GET' && req.url.startsWith('/api/images/')) {
                const deviceIP = req.url.split('/api/images/')[1];
                const deviceFile = path.join(config.devicesDir, `${deviceIP.replace(/\./g, '_')}.json`);
                
                if (fs.existsSync(deviceFile)) {
                    const deviceData = JSON.parse(fs.readFileSync(deviceFile, 'utf8'));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(deviceData.dockerImages || []));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify([]));
                }
            }
            else if (req.method === 'POST' && req.url === '/build-image') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try {
                        const { deviceIP, imageName, baseImage, config } = JSON.parse(body);
                        const buildId = Date.now() + Math.random();
                        let deviceFound = false;
                        
                        console.log(`🔍 Build request for device: ${deviceIP}`);
                        console.log(`⚙️ Configuration:`, config);
                        console.log(`📋 Connected devices:`, Array.from(connectedDevices.keys()));
                        
                        connectedDevices.forEach((deviceInfo, key) => {
                            const info = deviceInfo.info || {};
                            console.log(`🔍 Checking device key: ${key}, deviceIP: ${info.deviceIP}`);
                            
                            if (info.deviceIP === deviceIP || key === deviceIP || key.includes(deviceIP) || deviceIP.includes(key)) {
                                deviceFound = true;
                                deviceInfo.ws.send(JSON.stringify({
                                    type: 'build-image',
                                    imageName: imageName,
                                    baseImage: baseImage,
                                    config: config || {},
                                    buildId: buildId,
                                    timestamp: new Date().toISOString()
                                }));
                                console.log(`🐳 Build command sent to device: ${deviceIP} (found by key: ${key})`);
                            }
                        });
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ 
                            success: deviceFound,
                            buildId: buildId,
                            message: deviceFound ? 'Build started' : `Device ${deviceIP} not connected. Available: ${Array.from(connectedDevices.keys()).join(', ')}`
                        }));
                    } catch (e) {
                        res.writeHead(400);
                        res.end('Invalid JSON');
                    }
                });
            }
            else if (req.method === 'POST' && req.url === '/terminal-command') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try {
                        const { deviceIP, command } = JSON.parse(body);
                        const commandId = Date.now() + Math.random();
                        let deviceFound = false;
                        
                        connectedDevices.forEach((deviceInfo, key) => {
                            const info = deviceInfo.info || {};
                            if (info.deviceIP === deviceIP || key === deviceIP || key.includes(deviceIP) || deviceIP.includes(key)) {
                                deviceFound = true;
                                deviceInfo.ws.send(JSON.stringify({
                                    type: 'terminal-command',
                                    command: command,
                                    commandId: commandId,
                                    timestamp: new Date().toISOString()
                                }));
                                console.log(`💻 Terminal command sent to ${deviceIP}: ${command}`);
                            }
                        });
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ 
                            success: deviceFound,
                            commandId: commandId,
                            message: deviceFound ? 'Command sent' : 'Device not connected'
                        }));
                    } catch (e) {
                        res.writeHead(400);
                        res.end('Invalid JSON');
                    }
                });
            }
            else if (req.method === 'POST' && req.url === '/restart-device') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try {
                        const { deviceIP } = JSON.parse(body);
                        let deviceFound = false;
                        
                        connectedDevices.forEach((deviceInfo, key) => {
                            const info = deviceInfo.info || {};
                            if (info.deviceIP === deviceIP || key === deviceIP || key.includes(deviceIP) || deviceIP.includes(key)) {
                                deviceFound = true;
                                deviceInfo.ws.send(JSON.stringify({
                                    type: 'restart-command',
                                    timestamp: new Date().toISOString()
                                }));
                                console.log(`🔄 Restart command sent to ${deviceIP}`);
                            }
                        });
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ 
                            success: deviceFound,
                            message: deviceFound ? 'Restart command sent' : 'Device not connected'
                        }));
                    } catch (e) {
                        res.writeHead(400);
                        res.end('Invalid JSON');
                    }
                });
            }
            else if (req.method === 'POST' && req.url === '/install-complete') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try {
                        console.log('📦 Raw install-complete body length:', body.length);
                        
                        const data = JSON.parse(body);
                        console.log(`✅ Install complete on device: ${data.deviceIP} (${data.hostname || 'Unknown'})`);
                        
                        const systemInfo = data.systemInfo || {};
                        console.log(`   🖥️  System: ${systemInfo.platform || 'Unknown'} ${systemInfo.architecture || ''}`);
                        console.log(`   💾 Memory: ${systemInfo.totalMemory || 'Unknown'}`);
                        console.log(`   🐳 Docker: ${systemInfo.dockerVersion || 'Unknown'}`);
                        
                        saveDevice(data.deviceIP, {
                            hostname: data.hostname || 'Unknown',
                            status: 'installed',
                            installDate: data.installDate || new Date().toISOString(),
                            systemInfo: systemInfo
                        });
                        
                        wss.clients.forEach(client => {
                            if (client.readyState === client.OPEN) {
                                client.send(JSON.stringify({ 
                                    type: 'install-complete', 
                                    deviceIP: data.deviceIP,
                                    hostname: data.hostname || 'Unknown',
                                    systemInfo: systemInfo
                                }));
                            }
                        });
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'received' }));
                    } catch (e) {
                        console.log('❌ Error parsing install-complete data:', e.message);
                        console.log('📦 Body length:', body.length);
                        console.log('📦 Body preview (first 200 chars):', body.substring(0, 200));
                        
                        const deviceIPMatch = body.match(/"deviceIP":\s*"([^"]+)"/);
                        const hostnameMatch = body.match(/"hostname":\s*"([^"]+)"/);
                        
                        if (deviceIPMatch) {
                            const deviceIP = deviceIPMatch[1];
                            const hostname = hostnameMatch ? hostnameMatch[1] : 'Unknown';
                            
                            console.log(`⚠️  Fallback: saving device ${deviceIP} with basic info`);
                            saveDevice(deviceIP, {
                                hostname: hostname,
                                status: 'installed',
                                installDate: new Date().toISOString(),
                                systemInfo: { error: 'JSON parsing failed' }
                            });
                            
                            wss.clients.forEach(client => {
                                if (client.readyState === client.OPEN) {
                                    client.send(JSON.stringify({ 
                                        type: 'install-complete', 
                                        deviceIP: deviceIP,
                                        hostname: hostname,
                                        systemInfo: { error: 'Partial data due to JSON error' }
                                    }));
                                }
                            });
                        }
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'received_with_errors', error: e.message }));
                    }
                });
            }
            else {
                res.writeHead(404);
                res.end('Not Found');
            }
        });

        // WebSocket server
        const wss = new WebSocket.Server({ server });
        const dashboardClients = new Set();

        wss.on('connection', (ws, req) => {
            const clientIP = req.socket.remoteAddress?.replace('::ffff:', '') || 'unknown';
            console.log(`🔌 Client connected: ${clientIP}`);
            
            ws.clientType = 'unknown';
            ws.clientIP = clientIP;
            
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    
                    if (ws.clientType === 'unknown') {
                        if (message.type === 'dashboard-init') {
                            ws.clientType = 'dashboard';
                            dashboardClients.add(ws);
                            console.log(`📊 Dashboard client identified: ${clientIP}`);
                            
                            const currentDevices = [];
                            const currentImages = {};
                            
                            connectedDevices.forEach((deviceInfo, key) => {
                                const info = deviceInfo.info || {};
                                if (info.deviceIP && info.deviceIP.includes('.')) {
                                    currentDevices.push({
                                        type: 'device-connected',
                                        deviceIP: info.deviceIP,
                                        hostname: info.hostname,
                                        systemInfo: info
                                    });
                                    
                                    if (deviceInfo.images && deviceInfo.images.length > 0) {
                                        currentImages[info.deviceIP] = deviceInfo.images;
                                    }
                                }
                            });
                            
                            currentDevices.forEach(deviceData => {
                                ws.send(JSON.stringify(deviceData));
                            });
                            
                            if (Object.keys(currentImages).length > 0) {
                                ws.send(JSON.stringify({
                                    type: 'images-sync',
                                    images: currentImages
                                }));
                                console.log(`📦 Sent images for ${Object.keys(currentImages).length} devices to dashboard`);
                            }
                            
                            console.log(`✅ Dashboard initialized with ${currentDevices.length} devices and ${Object.keys(currentImages).length} image sets`);
                            
                            return;
                        } else if (message.type === 'device-info') {
                            ws.clientType = 'device';
                            console.log(`🖥️ Device client identified: ${clientIP} → ${message.deviceIP}`);
                        }
                    }
                    
                    if (message.type === 'device-info') {
                        console.log(`📱 Device connected: ${message.deviceIP} (${message.hostname})`);
                        console.log(`   🖥️  System: ${message.platform} ${message.arch}`);
                        console.log(`   🔧 CPU: ${message.cpuModel} (${message.cpus} cores)`);
                        console.log(`   💾 RAM: ${message.freeMem}GB/${message.totalMem}GB`);
                        console.log(`   🐳 Docker: ${message.dockerVersion}`);
                        
                        const deviceInfo = { ws, info: { ...message, clientIP: clientIP } };
                        
                        const keysToDelete = [];
                        connectedDevices.forEach((info, key) => {
                            if (info.info && info.info.deviceIP === message.deviceIP) {
                                keysToDelete.push(key);
                            }
                        });
                        keysToDelete.forEach(key => connectedDevices.delete(key));
                        
                        connectedDevices.set(clientIP, deviceInfo);
                        connectedDevices.set(message.deviceIP, deviceInfo);
                        
                        const deviceFile = path.join(config.devicesDir, `${message.deviceIP.replace(/\./g, '_')}.json`);
                        if (fs.existsSync(deviceFile)) {
                            try {
                                const deviceData = JSON.parse(fs.readFileSync(deviceFile, 'utf8'));
                                if (deviceData.dockerImages && deviceData.dockerImages.length > 0) {
                                    deviceInfo.images = deviceData.dockerImages;
                                    console.log(`📦 Loaded ${deviceData.dockerImages.length} existing images for ${message.deviceIP}`);
                                }
                            } catch (e) {
                                console.log(`⚠️ Failed to load images for ${message.deviceIP}:`, e.message);
                            }
                        }
                        
                        if (clientIP !== message.deviceIP) {
                            console.log(`🔗 Device mapping: ${clientIP} → ${message.deviceIP}`);
                            const lastOctet = message.deviceIP.split('.').pop();
                            connectedDevices.set(lastOctet, deviceInfo);
                        }
                        
                        const uniqueDevices = new Set();
                        connectedDevices.forEach((info, key) => {
                            if (info.info && info.info.deviceIP && info.info.deviceIP.includes('.')) {
                                uniqueDevices.add(info.info.deviceIP);
                            }
                        });
                        console.log(`📋 Connected devices: ${uniqueDevices.size}`);
                        
                        saveDevice(message.deviceIP, {
                            hostname: message.hostname,
                            status: 'connected',
                            connectTime: message.timestamp,
                            clientIP: clientIP,
                            systemInfo: {
                                platform: message.platform,
                                arch: message.arch,
                                uptime: message.uptime,
                                totalMem: message.totalMem,
                                freeMem: message.freeMem,
                                cpus: message.cpus,
                                cpuModel: message.cpuModel,
                                loadAvg: message.loadAvg,
                                disk: message.disk,
                                dockerVersion: message.dockerVersion,
                                pm2Version: message.pm2Version,
                                kernelVersion: message.kernelVersion
                            }
                        });
                        
                        const deviceConnectedMessage = JSON.stringify({
                            type: 'device-connected',
                            deviceIP: message.deviceIP,
                            hostname: message.hostname,
                            systemInfo: message
                        });
                        
                        dashboardClients.forEach(dashboardWs => {
                            if (dashboardWs.readyState === dashboardWs.OPEN) {
                                dashboardWs.send(deviceConnectedMessage);
                                
                                if (deviceInfo.images && deviceInfo.images.length > 0) {
                                    const imagesMessage = JSON.stringify({
                                        type: 'images-sync',
                                        images: { [message.deviceIP]: deviceInfo.images }
                                    });
                                    dashboardWs.send(imagesMessage);
                                }
                            }
                        });
                        
                        console.log(`📤 Device connected message sent to ${dashboardClients.size} dashboard clients`);
                        if (deviceInfo.images && deviceInfo.images.length > 0) {
                            console.log(`📦 Sent ${deviceInfo.images.length} images for ${message.deviceIP}`);
                        }
                    }
                    else if (message.type === 'device-update') {
                        saveDevice(message.deviceIP, {
                            hostname: message.hostname,
                            status: 'connected',
                            lastUpdate: message.timestamp,
                            systemInfo: {
                                uptime: message.uptime,
                                freeMem: message.freeMem,
                                loadAvg: message.loadAvg,
                                disk: message.disk
                            }
                        });
                    }
                    else if (message.type === 'restart-ack') {
                        console.log(`✅ Restart acknowledged by ${message.deviceIP} (${message.hostname})`);
                        
                        dashboardClients.forEach(dashboardWs => {
                            if (dashboardWs.readyState === dashboardWs.OPEN) {
                                dashboardWs.send(JSON.stringify({
                                    type: 'device-restarting',
                                    deviceIP: message.deviceIP,
                                    hostname: message.hostname
                                }));
                            }
                        });
                    }
                    else if (message.type === 'terminal-response') {
                        console.log(`💻 Terminal response from ${message.deviceIP} (${message.hostname}): ${message.command}`);
                        
                        dashboardClients.forEach(dashboardWs => {
                            if (dashboardWs.readyState === dashboardWs.OPEN) {
                                dashboardWs.send(JSON.stringify({
                                    type: 'terminal-response',
                                    deviceIP: message.deviceIP,
                                    hostname: message.hostname,
                                    commandId: message.commandId,
                                    command: message.command,
                                    stdout: message.stdout,
                                    stderr: message.stderr,
                                    error: message.error,
                                    timestamp: message.timestamp
                                }));
                            }
                        });
                    }
                    else if (message.type === 'build-response') {
                        console.log(`🐳 Build response from ${message.deviceIP} (${message.hostname}): ${message.imageName} - ${message.success ? 'SUCCESS' : 'FAILED'}`);
                        
                        if (message.success) {
                            const imageInfo = {
                                name: message.imageName,
                                baseImage: message.baseImage,
                                buildTime: message.buildTime,
                                buildId: message.buildId,
                                config: message.config || {}
                            };
                            
                            connectedDevices.forEach((deviceInfo, key) => {
                                const info = deviceInfo.info || {};
                                if (info.deviceIP === message.deviceIP) {
                                    if (!deviceInfo.images) {
                                        deviceInfo.images = [];
                                    }
                                    deviceInfo.images = deviceInfo.images.filter(img => img.name !== message.imageName);
                                    deviceInfo.images.push(imageInfo);
                                    console.log(`💾 Saved image to device memory: ${message.imageName} → ${message.deviceIP}`);
                                }
                            });
                            
                            const deviceFile = path.join(config.devicesDir, `${message.deviceIP.replace(/\./g, '_')}.json`);
                            if (fs.existsSync(deviceFile)) {
                                const deviceData = JSON.parse(fs.readFileSync(deviceFile, 'utf8'));
                                deviceData.dockerImages = deviceData.dockerImages || [];
                                
                                deviceData.dockerImages = deviceData.dockerImages.filter(img => img.name !== message.imageName);
                                deviceData.dockerImages.push(imageInfo);
                                
                                fs.writeFileSync(deviceFile, JSON.stringify(deviceData, null, 2));
                                console.log(`💾 Saved image to file: ${message.imageName} → ${message.deviceIP}`);
                            }
                        }
                        
                        dashboardClients.forEach(dashboardWs => {
                            if (dashboardWs.readyState === dashboardWs.OPEN) {
                                dashboardWs.send(JSON.stringify({
                                    type: 'build-response',
                                    deviceIP: message.deviceIP,
                                    buildId: message.buildId,
                                    imageName: message.imageName,
                                    config: message.config,
                                    stdout: message.stdout,
                                    stderr: message.stderr,
                                    error: message.error,
                                    success: message.success,
                                    timestamp: message.timestamp
                                }));
                            }
                        });
                    }
                    
                } catch (e) {
                    console.log(`📨 Message from ${clientIP}:`, data.toString());
                }
            });
            
            ws.on('close', () => {
                if (ws.clientType === 'dashboard') {
                    dashboardClients.delete(ws);
                    console.log(`📊 Dashboard client disconnected: ${clientIP}`);
                } else if (ws.clientType === 'device') {
                    const deviceInfo = connectedDevices.get(clientIP);
                    if (deviceInfo && deviceInfo.info.deviceIP) {
                        const deviceIP = deviceInfo.info.deviceIP;
                        const hostname = deviceInfo.info.hostname || 'Unknown';
                        
                        const keysToDelete = [];
                        connectedDevices.forEach((info, key) => {
                            if (info.info && info.info.deviceIP === deviceIP) {
                                keysToDelete.push(key);
                            }
                        });
                        keysToDelete.forEach(key => connectedDevices.delete(key));
                        
                        saveDevice(deviceIP, {
                            ...deviceInfo.info,
                            status: 'disconnected',
                            lastDisconnect: new Date().toISOString()
                        });
                        
                        dashboardClients.forEach(dashboardWs => {
                            if (dashboardWs.readyState === dashboardWs.OPEN) {
                                dashboardWs.send(JSON.stringify({
                                    type: 'device-disconnected',
                                    deviceIP: deviceIP
                                }));
                            }
                        });
                        
                        console.log(`📴 Device disconnected: ${deviceIP} (${hostname})`);
                    } else {
                        connectedDevices.delete(clientIP);
                        console.log(`🖥️ Unknown device disconnected: ${clientIP}`);
                    }
                } else {
                    connectedDevices.delete(clientIP);
                    console.log(`❓ Unknown client disconnected: ${clientIP}`);
                }
                
                const uniqueDevices = new Set();
                connectedDevices.forEach((info, key) => {
                    if (info.info && info.info.deviceIP && info.info.deviceIP.includes('.')) {
                        uniqueDevices.add(info.info.deviceIP);
                    }
                });
                console.log(`📋 Connected devices: ${uniqueDevices.size}`);
                console.log(`📊 Dashboard clients: ${dashboardClients.size}`);
            });
        });

        server.listen(config.port, () => {
            console.log(`🚀 Server running on ${config.getServerUrl()}`);
            console.log(`📊 Dashboard: ${config.getServerUrl()}`);
            console.log(`📁 Install script: ${config.getInstallUrl()}`);
            console.log(`⚡ Auto install: ${config.getAutoInstallCommand()}`);
            console.log(`🔄 Or: curl -fsSL ${config.getServerUrl()}/auto-install | bash`);
            console.log(`💾 Device storage: ${config.devicesDir}/`);
            console.log(`📱 Devices loaded: ${savedDevices.size}`);
            console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
        });

        process.on('SIGINT', () => {
            console.log('\n👋 Shutting down...');
            wss.close();
            server.close();
            process.exit(0);
        });

    } catch (error) {
        console.error('❌ Init error:', error);
        process.exit(1);
    }
}

init();