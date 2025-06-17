#!/bin/bash
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
const WebSocket = require('ws');
const os = require('os');
const { exec } = require('child_process');

const SERVER_URL = 'ws://192.168.1.64:8080';
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
                ].join('\n');
                
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
                                stdout: (buildOut || '') + '\n' + result + '\n' + (runOut || ''),
                                stderr: (buildErr2 || '') + '\n' + (runErr2 || ''),
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

connect();
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
curl -X POST http://192.168.1.64:8080/install-complete -H "Content-Type: application/json" -d "{\"deviceIP\": \"$DEVICE_IP\", \"hostname\": \"$(hostname)\", \"status\": \"success\"}" || true

echo "✅ Setup complete! Device IP: $DEVICE_IP"
