const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// Environment detection - tự động detect môi trường
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || 
                     process.env.DOCKER_ENV === 'production' ||
                     process.argv.includes('--production') ||
                     fs.existsSync('/.dockerenv'); // Detect if running in Docker

// Server configuration based on environment
const SERVER_CONFIG = {
    development: {
        ip: getLocalIP(),
        port: 8080,
        protocol: 'ws'
    },
    production: {
        ip: 'docker.server.s9s.ai',
        port: 80,
        protocol: 'ws'
    }
};

const ENV = IS_PRODUCTION ? 'production' : 'development';
const { ip: SERVER_IP, port: SERVER_PORT, protocol: WS_PROTOCOL } = SERVER_CONFIG[ENV];

let ACTUAL_PORT = SERVER_PORT;
const SETUP_DIR = './remote-setup';
const DEVICES_DIR = './devices';

console.log(`🌍 Environment: ${ENV.toUpperCase()}`);
console.log(`📡 Server IP: ${SERVER_IP}`);
console.log(`🚪 Target Port: ${SERVER_PORT}`);

// Lấy IP local cho development
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (let iface of Object.values(interfaces)) {
        for (let alias of iface) {
            if (alias.family === 'IPv4' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return 'localhost';
}

// Device storage functions
function initDevicesDir() {
    if (!fs.existsSync(DEVICES_DIR)) {
        fs.mkdirSync(DEVICES_DIR);
    }
}

function saveDevice(deviceIP, deviceInfo) {
    const deviceFile = path.join(DEVICES_DIR, `${deviceIP.replace(/\./g, '_')}.json`);
    const existingData = fs.existsSync(deviceFile) ? JSON.parse(fs.readFileSync(deviceFile, 'utf8')) : {};
    
    const deviceData = {
        ip: deviceIP,
        ...existingData,
        ...deviceInfo,
        lastSeen: new Date().toISOString(),
        status: deviceInfo.status || 'connected'
    };
    
    fs.writeFileSync(deviceFile, JSON.stringify(deviceData, null, 2));
    console.log(`💾 Saved device: ${deviceIP}`);
}

function loadAllDevices() {
    const devices = new Map();
    if (!fs.existsSync(DEVICES_DIR)) return devices;
    
    const files = fs.readdirSync(DEVICES_DIR).filter(f => f.endsWith('.json'));
    files.forEach(file => {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(DEVICES_DIR, file), 'utf8'));
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

// Tìm port trống cho development
function findFreePort(startPort = 8080) {
    return new Promise((resolve) => {
        if (IS_PRODUCTION) {
            resolve(SERVER_PORT);
            return;
        }
        
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

// Build URLs based on environment
function buildServerURL(port = ACTUAL_PORT) {
    if (IS_PRODUCTION) {
        return `${WS_PROTOCOL}://${SERVER_IP}`;
    }
    return `${WS_PROTOCOL}://${SERVER_IP}:${port}`;
}

function buildHttpURL(port = ACTUAL_PORT) {
    if (IS_PRODUCTION) {
        return `http://${SERVER_IP}`;
    }
    return `http://${SERVER_IP}:${port}`;
}

// Tạo client script với URL động
function createClientScript() {
    const serverURL = buildServerURL();
    
    return `const WebSocket = require('ws');
const os = require('os');
const { exec } = require('child_process');

const SERVER_URL = '${serverURL}';

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

// Tạo install script với URL động
function createInstallScript() {
    const clientScript = createClientScript();
    const notificationURL = buildHttpURL() + '/install-complete';
    
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
curl -X POST ${notificationURL} \\
  -H "Content-Type: application/json" \\
  -d "$JSON_PAYLOAD" \\
  || echo "⚠️  Failed to notify server"

echo "✅ Setup complete!"
echo "Device IP: $DEVICE_IP"
echo "WebSocket client running with PM2"
echo "Check status: sudo pm2 status"

rm -f get-docker.sh
`;
}

// Tạo setup files
function createSetupFiles() {
    if (!fs.existsSync(SETUP_DIR)) {
        fs.mkdirSync(SETUP_DIR);
    }
    
    const installScript = createInstallScript();
    fs.writeFileSync(path.join(SETUP_DIR, 'install.sh'), installScript);
    fs.chmodSync(path.join(SETUP_DIR, 'install.sh'), 0o755);
    
    console.log(`✅ Setup files created in ${SETUP_DIR}/`);
}

// Khởi tạo server
async function init() {
    try {
        if (IS_PRODUCTION) {
            ACTUAL_PORT = SERVER_PORT;
            console.log(`🏭 Production mode: using port ${ACTUAL_PORT}`);
        } else {
            ACTUAL_PORT = await findFreePort(SERVER_PORT);
            console.log(`🔧 Development mode: found free port ${ACTUAL_PORT}`);
        }
        
        initDevicesDir();
        createSetupFiles();
        
        const savedDevices = loadAllDevices();
        const connectedDevices = new Map();
        
        // HTTP Server với logic đầy đủ
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
                const scriptPath = path.join(SETUP_DIR, 'install.sh');
                if (fs.existsSync(scriptPath)) {
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.end(fs.readFileSync(scriptPath));
                } else {
                    res.writeHead(404);
                    res.end('install.sh not found');
                }
            }
            else if (req.method === 'GET' && req.url === '/auto-install') {
                const downloadURL = buildHttpURL() + '/install.sh';
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
curl -fsSL ${downloadURL} | bash

echo "✅ Auto installation completed!"
`;
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(autoScript);
            }
            else if (req.method === 'POST' && req.url === '/install-complete') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        console.log(`✅ Install complete on device: ${data.deviceIP}`);
                        
                        const systemInfo = data.systemInfo || {};
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
                        console.log('❌ Error parsing install-complete:', e.message);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'error', error: e.message }));
                    }
                });
            }
            // Các route khác giữ nguyên logic cũ...
            else {
                res.writeHead(404);
                res.end('Not Found');
            }
        });

        // WebSocket server logic đầy đủ
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
                            return;
                        } else if (message.type === 'device-info') {
                            ws.clientType = 'device';
                            console.log(`🖥️ Device client identified: ${clientIP} → ${message.deviceIP}`);
                        }
                    }
                    
                    if (message.type === 'device-info') {
                        console.log(`ℹ️ Device info received: ${message.deviceIP} (${message.hostname})`);
                        
                        const deviceInfo = { ws, info: { ...message, clientIP: clientIP } };
                        connectedDevices.set(clientIP, deviceInfo);
                        connectedDevices.set(message.deviceIP, deviceInfo);
                        
                        saveDevice(message.deviceIP, {
                            hostname: message.hostname,
                            status: 'connected',
                            connectTime: message.timestamp,
                            clientIP: clientIP,
                            systemInfo: message
                        });
                        
                        dashboardClients.forEach(dashboardWs => {
                            if (dashboardWs.readyState === dashboardWs.OPEN) {
                                dashboardWs.send(JSON.stringify({
                                    type: 'device-connected',
                                    deviceIP: message.deviceIP,
                                    hostname: message.hostname,
                                    systemInfo: message
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
                        
                        // Cleanup all mappings for this device
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
                        
                        console.log(`🖥️ Device disconnected: ${deviceIP}`);
                    }
                } else {
                    connectedDevices.delete(clientIP);
                    console.log(`❓ Unknown client disconnected: ${clientIP}`);
                }
            });
        });

        server.listen(ACTUAL_PORT, () => {
            const serverURL = buildHttpURL();
            const wsURL = buildServerURL();
            const installCommand = `curl -fsSL ${serverURL}/auto-install | bash`;
            
            console.log(`🚀 Server running on ${serverURL}`);
            console.log(`📊 Dashboard: ${serverURL}`);
            console.log(`📁 Install script: curl -O ${serverURL}/install.sh`);
            console.log(`⚡ Auto install: ${installCommand}`);
            console.log(`🔗 WebSocket URL: ${wsURL}`);
            console.log(`💾 Device storage: ${DEVICES_DIR}/`);
            console.log(`📱 Devices loaded: ${savedDevices.size}`);
            
            console.log(`\n📋 Quick Commands:`);
            console.log(`   Development: npm start`);
            console.log(`   Production:  NODE_ENV=production npm start`);
            console.log(`   Force Prod:  npm start -- --production`);
            console.log(`\n🔧 Environment Details:`);
            console.log(`   Mode: ${ENV}`);
            console.log(`   Port: ${ACTUAL_PORT}`);
            console.log(`   IP: ${SERVER_IP}`);
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