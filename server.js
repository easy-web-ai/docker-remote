const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// Environment detection
const IS_PROD = process.env.NODE_ENV === 'production' || 
                process.argv.includes('--production') || 
                fs.existsSync('/.dockerenv');

// Configuration
const CONFIG = IS_PROD ? {
    ip: 'docker.server.s9s.ai',
    port: 80,
    ws: 'wss',
    http: 'https'
} : {
    ip: getLocalIP(),
    port: 8080,
    ws: 'ws',
    http: 'http'
};

const SETUP_DIR = './remote-setup';
const DEVICES_DIR = './devices';

console.log(`🌍 ${IS_PROD ? 'PRODUCTION' : 'DEVELOPMENT'} mode`);

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

function buildURL(protocol, port = CONFIG.port) {
    return IS_PROD ? `${protocol}://${CONFIG.ip}` : `${protocol}://${CONFIG.ip}:${port}`;
}

function saveDevice(deviceIP, deviceInfo) {
    if (!fs.existsSync(DEVICES_DIR)) fs.mkdirSync(DEVICES_DIR);
    
    const deviceFile = path.join(DEVICES_DIR, `${deviceIP.replace(/\./g, '_')}.json`);
    const existing = fs.existsSync(deviceFile) ? JSON.parse(fs.readFileSync(deviceFile, 'utf8')) : {};
    
    const deviceData = {
        ip: deviceIP,
        ...existing,
        ...deviceInfo,
        lastSeen: new Date().toISOString()
    };
    
    fs.writeFileSync(deviceFile, JSON.stringify(deviceData, null, 2));
    console.log(`💾 Saved: ${deviceIP}`);
}

function createClientScript() {
    const wsURL = buildURL(CONFIG.ws);
    
    return `const WebSocket = require('ws');
const os = require('os');
const { exec } = require('child_process');

const SERVER_URL = '${wsURL}';
const DEVICE_IP = os.networkInterfaces().eth0?.[0]?.address || 
                  os.networkInterfaces().wlan0?.[0]?.address || 
                  Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address || 'unknown';

let ws, reconnectInterval = 5000;

function getSystemInfo() {
    return {
        hostname: os.hostname(),
        deviceIP: DEVICE_IP,
        platform: os.platform(),
        arch: os.arch(),
        uptime: Math.floor(os.uptime()),
        totalMem: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 100) / 100,
        freeMem: Math.round(os.freemem() / 1024 / 1024 / 1024 * 100) / 100,
        cpus: os.cpus().length,
        cpuModel: (os.cpus()[0]?.model || 'Unknown').substring(0, 50),
        timestamp: new Date().toISOString()
    };
}

function connect() {
    console.log('🔌 Connecting to', SERVER_URL);
    ws = new WebSocket(SERVER_URL);
    
    ws.on('open', () => {
        console.log('✅ Connected! IP:', DEVICE_IP);
        ws.send(JSON.stringify({ type: 'device-info', ...getSystemInfo() }));
        
        setInterval(() => {
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'device-update', ...getSystemInfo() }));
            }
        }, 30000);
    });
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            
            if (msg.type === 'restart-command') {
                ws.send(JSON.stringify({ type: 'restart-ack', deviceIP: DEVICE_IP, hostname: os.hostname() }));
                setTimeout(() => exec('sudo reboot'), 2000);
            }
            
            if (msg.type === 'terminal-command') {
                exec(msg.command, { timeout: 30000 }, (err, stdout, stderr) => {
                    ws.send(JSON.stringify({
                        type: 'terminal-response',
                        deviceIP: DEVICE_IP,
                        commandId: msg.commandId,
                        command: msg.command,
                        stdout: stdout || '',
                        stderr: stderr || '',
                        error: err?.message || null
                    }));
                });
            }
            
            if (msg.type === 'build-image') {
                console.log('🐳 Building:', msg.imageName);
                const tempDir = '/tmp/docker-build-' + Date.now();
                const config = msg.config || {};
                
                const dockerfile = [
                    'FROM ' + msg.baseImage,
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
                            buildId: msg.buildId,
                            imageName: msg.imageName,
                            error: 'Failed to create build directory',
                            success: false
                        }));
                        return;
                    }
                    
                    require('fs').writeFileSync(tempDir + '/Dockerfile', dockerfile);
                    
                    const buildCmd = 'cd ' + tempDir + ' && docker build -t ' + msg.imageName + ' .';
                    exec(buildCmd, { timeout: 300000, maxBuffer: 5 * 1024 * 1024 }, (buildErr, buildOut, buildErr2) => {
                        if (buildErr) {
                            exec('rm -rf ' + tempDir, () => {});
                            ws.send(JSON.stringify({
                                type: 'build-response',
                                deviceIP: DEVICE_IP,
                                buildId: msg.buildId,
                                imageName: msg.imageName,
                                stdout: buildOut || '',
                                stderr: buildErr2 || '',
                                error: buildErr.message,
                                success: false
                            }));
                            return;
                        }
                        
                        console.log('✅ Built successfully, starting container...');
                        
                        let runCmd = 'docker run -d';
                        if (config.ram) runCmd += ' --memory=' + config.ram + 'm';
                        if (config.cpu) runCmd += ' --cpus=' + config.cpu;
                        if (config.port) runCmd += ' -p ' + config.port;
                        if (config.network) runCmd += ' --network=' + config.network;
                        if (config.disk) runCmd += ' --tmpfs /tmp:size=' + config.disk + 'g';
                        runCmd += ' --name=' + msg.imageName.replace(/[^a-zA-Z0-9]/g, '-') + '-' + Date.now();
                        runCmd += ' ' + msg.imageName;
                        
                        exec(runCmd, { timeout: 60000 }, (runErr, runOut, runErr2) => {
                            exec('rm -rf ' + tempDir, () => {});
                            
                            const result = runErr ? 
                                '❌ Container failed: ' + runErr.message :
                                '✅ Container started: ' + (runOut || '').trim();
                            
                            ws.send(JSON.stringify({
                                type: 'build-response',
                                deviceIP: DEVICE_IP,
                                buildId: msg.buildId,
                                imageName: msg.imageName,
                                baseImage: msg.baseImage,
                                config: config,
                                stdout: (buildOut || '') + '\\n' + result + '\\n' + (runOut || ''),
                                stderr: (buildErr2 || '') + '\\n' + (runErr2 || ''),
                                error: runErr ? runErr.message : null,
                                success: !runErr,
                                buildTime: new Date().toISOString()
                            }));
                        });
                    });
                });
            }
        } catch (e) {
            console.log('📨 Unknown message:', data.toString());
        }
    });
    
    ws.on('close', () => {
        console.log('❌ Disconnected. Reconnecting...');
        setTimeout(connect, reconnectInterval);
        reconnectInterval = Math.min(reconnectInterval * 1.5, 30000);
    });
    
    ws.on('error', (err) => console.log('🔄 Error:', err.code || err.message));
}

connect();`;
}

function createInstallScript() {
    const clientScript = createClientScript();
    const notifyURL = buildURL(CONFIG.http) + '/install-complete';
    
    return `#!/bin/bash
set -e
echo "🔧 Installing Docker management client..."

# Install prerequisites
sudo apt-get update -y
sudo apt-get install -y curl wget

# Install Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER

# Install Node.js & PM2
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2

# Setup client
DEVICE_IP=$(hostname -I | awk '{print $1}')
WS_CLIENT_DIR="/opt/docker-client"
sudo mkdir -p $WS_CLIENT_DIR

# Create client files
cat > /tmp/client.js << 'EOF'
${clientScript}
EOF

cat > /tmp/package.json << 'EOF'
{"name": "docker-client", "main": "client.js", "dependencies": {"ws": "^8.14.2"}}
EOF

sudo mv /tmp/client.js /tmp/package.json $WS_CLIENT_DIR/
cd $WS_CLIENT_DIR && sudo npm install

# Start with PM2
sudo pm2 start client.js --name "docker-client"
sudo pm2 startup && sudo pm2 save

# Setup sudo permissions
echo "root ALL=(ALL) NOPASSWD: /sbin/reboot" | sudo tee /etc/sudoers.d/docker-client
sudo chmod 440 /etc/sudoers.d/docker-client

# Notify server
curl -X POST ${notifyURL} -H "Content-Type: application/json" -d "{\\"deviceIP\\": \\"$DEVICE_IP\\", \\"hostname\\": \\"$(hostname)\\", \\"status\\": \\"success\\"}" || true

echo "✅ Setup complete! Device IP: $DEVICE_IP"
`;
}

async function findPort(start = CONFIG.port) {
    if (IS_PROD) return CONFIG.port;
    
    return new Promise(resolve => {
        const server = require('net').createServer();
        server.listen(start, () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        }).on('error', () => resolve(findPort(start + 1)));
    });
}

async function init() {
    const port = await findPort();
    
    // Create setup files
    if (!fs.existsSync(SETUP_DIR)) fs.mkdirSync(SETUP_DIR);
    fs.writeFileSync(path.join(SETUP_DIR, 'install.sh'), createInstallScript());
    fs.chmodSync(path.join(SETUP_DIR, 'install.sh'), 0o755);
    
    const connectedDevices = new Map();
    const dashboardClients = new Set();
    
    // HTTP Server
    const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        // Serve dashboard
        if (req.url === '/' || req.url === '/index.html') {
            const indexPath = path.join(__dirname, 'index.html');
            if (fs.existsSync(indexPath)) {
                let content = fs.readFileSync(indexPath, 'utf8');
                const wsConfig = `<script>window.WS_URL='${buildURL(CONFIG.ws, port)}';</script>`;
                content = content.replace('</head>', wsConfig + '</head>');
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(content);
            } else {
                res.writeHead(404);
                res.end('Dashboard not found');
            }
            return;
        }
        
        // Serve install script
        if (req.url === '/install.sh') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(fs.readFileSync(path.join(SETUP_DIR, 'install.sh')));
            return;
        }
        
        // Auto install
        if (req.url === '/auto-install') {
            const cmd = `curl -fsSL ${buildURL(CONFIG.http, port)}/install.sh | bash`;
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(`#!/bin/bash\necho "🚀 Auto Docker Setup"\n${cmd}`);
            return;
        }
        
        // API: Connected devices
        if (req.url === '/api/connected') {
            const devices = {};
            connectedDevices.forEach((info, key) => {
                if (info.deviceIP?.includes('.')) {
                    devices[info.deviceIP] = {
                        deviceIP: info.deviceIP,
                        hostname: info.hostname,
                        status: 'connected'
                    };
                }
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(devices));
            return;
        }
        
        // Build Docker image
        if (req.method === 'POST' && req.url === '/build-image') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const { deviceIP, imageName, baseImage, config } = JSON.parse(body);
                    const buildId = Date.now() + Math.random();
                    let found = false;
                    
                    connectedDevices.forEach((deviceInfo, key) => {
                        if (deviceInfo.deviceIP === deviceIP) {
                            found = true;
                            // Find WebSocket connection
                            wss.clients.forEach(client => {
                                if (client.deviceIP === deviceIP) {
                                    client.send(JSON.stringify({
                                        type: 'build-image',
                                        imageName,
                                        baseImage,
                                        config: config || {},
                                        buildId
                                    }));
                                }
                            });
                        }
                    });
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: found,
                        buildId,
                        message: found ? 'Build started' : 'Device not connected'
                    }));
                } catch (e) {
                    res.writeHead(400);
                    res.end('Invalid JSON');
                }
            });
            return;
        }
        
        // Terminal command
        if (req.method === 'POST' && req.url === '/terminal-command') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const { deviceIP, command } = JSON.parse(body);
                    const commandId = Date.now() + Math.random();
                    let found = false;
                    
                    wss.clients.forEach(client => {
                        if (client.deviceIP === deviceIP) {
                            found = true;
                            client.send(JSON.stringify({
                                type: 'terminal-command',
                                command,
                                commandId
                            }));
                        }
                    });
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: found,
                        commandId,
                        message: found ? 'Command sent' : 'Device not connected'
                    }));
                } catch (e) {
                    res.writeHead(400);
                    res.end('Invalid JSON');
                }
            });
            return;
        }
        
        // Restart device
        if (req.method === 'POST' && req.url === '/restart-device') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const { deviceIP } = JSON.parse(body);
                    let found = false;
                    
                    wss.clients.forEach(client => {
                        if (client.deviceIP === deviceIP) {
                            found = true;
                            client.send(JSON.stringify({ type: 'restart-command' }));
                        }
                    });
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: found,
                        message: found ? 'Restart command sent' : 'Device not connected'
                    }));
                } catch (e) {
                    res.writeHead(400);
                    res.end('Invalid JSON');
                }
            });
            return;
        }
        
        // Install complete notification
        if (req.method === 'POST' && req.url === '/install-complete') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    console.log(`✅ Install complete: ${data.deviceIP}`);
                    saveDevice(data.deviceIP, { hostname: data.hostname, status: 'installed' });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('{"status":"ok"}');
                } catch (e) {
                    res.writeHead(400);
                    res.end('Invalid JSON');
                }
            });
            return;
        }
        
        res.writeHead(404);
        res.end('Not Found');
    });
    
    // WebSocket Server
    const wss = new WebSocket.Server({ server });
    
    wss.on('connection', (ws, req) => {
        const clientIP = req.socket.remoteAddress?.replace('::ffff:', '') || 'unknown';
        console.log(`🔌 Client: ${clientIP}`);
        
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                
                if (msg.type === 'dashboard-init') {
                    dashboardClients.add(ws);
                    ws.clientType = 'dashboard';
                    console.log(`📊 Dashboard: ${clientIP}`);
                    
                    // Send current connected devices
                    connectedDevices.forEach((deviceInfo, deviceIP) => {
                        if (deviceIP.includes('.')) {
                            ws.send(JSON.stringify({
                                type: 'device-connected',
                                deviceIP,
                                hostname: deviceInfo.hostname,
                                systemInfo: deviceInfo
                            }));
                        }
                    });
                    return;
                }
                
                if (msg.type === 'device-info') {
                    console.log(`🖥️ Device: ${msg.deviceIP} (${msg.hostname})`);
                    ws.deviceIP = msg.deviceIP;
                    ws.clientType = 'device';
                    connectedDevices.set(msg.deviceIP, msg);
                    saveDevice(msg.deviceIP, { ...msg, status: 'connected' });
                    
                    // Notify dashboards
                    dashboardClients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'device-connected',
                                deviceIP: msg.deviceIP,
                                hostname: msg.hostname,
                                systemInfo: msg
                            }));
                        }
                    });
                    return;
                }
                
                if (msg.type === 'device-update') {
                    if (ws.deviceIP) {
                        connectedDevices.set(ws.deviceIP, { ...connectedDevices.get(ws.deviceIP), ...msg });
                        saveDevice(ws.deviceIP, { ...msg, status: 'connected' });
                    }
                    return;
                }
                
                // Forward responses to dashboards
                if (['terminal-response', 'build-response', 'restart-ack'].includes(msg.type)) {
                    dashboardClients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(msg));
                        }
                    });
                }
                
            } catch (e) {
                console.log(`📨 Raw: ${data}`);
            }
        });
        
        ws.on('close', () => {
            if (ws.clientType === 'dashboard') {
                dashboardClients.delete(ws);
                console.log(`📊 Dashboard disconnected: ${clientIP}`);
            } else if (ws.clientType === 'device' && ws.deviceIP) {
                connectedDevices.delete(ws.deviceIP);
                saveDevice(ws.deviceIP, { status: 'disconnected', lastDisconnect: new Date().toISOString() });
                
                // Notify dashboards
                dashboardClients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'device-disconnected',
                            deviceIP: ws.deviceIP
                        }));
                    }
                });
                console.log(`🖥️ Device disconnected: ${ws.deviceIP}`);
            } else {
                console.log(`❌ Unknown client disconnected: ${clientIP}`);
            }
        });
    });
    
    // Start server
    server.listen(port, () => {
        const url = buildURL(CONFIG.http, port);
        console.log(`🚀 Server: ${url}`);
        console.log(`📁 Install: curl -O ${url}/install.sh`);
        console.log(`⚡ Auto: curl -fsSL ${url}/auto-install | bash`);
        console.log(`🔗 WebSocket: ${buildURL(CONFIG.ws, port)}`);
    });
    
    process.on('SIGINT', () => {
        console.log('\n👋 Shutting down...');
        process.exit(0);
    });
}

init().catch(console.error);