require('dotenv').config();
const os = require('os');

class Config {
    constructor() {
        this.isDevelopment = process.env.NODE_ENV === 'development';
        this.isProduction = process.env.NODE_ENV === 'production';
        
        // Initialize configuration
        this.init();
    }

    init() {
        if (this.isDevelopment) {
            this.host = process.env.DEV_HOST || 'localhost';
            this.port = parseInt(process.env.DEV_PORT) || 8080;
        } else {
            this.host = process.env.PROD_DOMAIN || this.getLocalIP();
            this.port = parseInt(process.env.PROD_PORT) || 8080;
        }

        // Allow override
        if (process.env.FORCE_HOST) {
            this.host = process.env.FORCE_HOST;
        }
        if (process.env.FORCE_PORT) {
            this.port = parseInt(process.env.FORCE_PORT);
        }

        // WebSocket settings
        this.wsSecure = process.env.WS_SECURE === 'true';
        this.wsProtocol = this.wsSecure ? 'wss' : 'ws';
        this.httpProtocol = this.wsSecure ? 'https' : 'http';

        // Storage paths
        this.devicesDir = process.env.DEVICES_DIR || './devices';
        this.setupDir = process.env.SETUP_DIR || './remote-setup';
    }

    getLocalIP() {
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

    // Get server address for client scripts
    getServerAddress() {
        if (this.isDevelopment) {
            return `${this.host}:${this.port}`;
        } else {
            return this.host;
        }
    }

    // Get full server URL
    getServerUrl() {
        return `${this.httpProtocol}://${this.getServerAddress()}`;
    }

    // Get WebSocket URL
    getWebSocketUrl() {
        return `${this.wsProtocol}://${this.getServerAddress()}`;
    }

    // Get install script URL
    getInstallUrl() {
        return `${this.getServerUrl()}/install.sh`;
    }

    // Get auto-install command
    getAutoInstallCommand() {
        return `bash <(wget -qO- ${this.getServerUrl()}/auto-install)`;
    }

    // Get manual install command
    getManualInstallCommand() {
        return `curl -O ${this.getInstallUrl()} && chmod +x install.sh && ./install.sh`;
    }

    // Display configuration
    display() {
        console.log('📋 Configuration:');
        console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`   Host: ${this.host}`);
        console.log(`   Port: ${this.port}`);
        console.log(`   Server URL: ${this.getServerUrl()}`);
        console.log(`   WebSocket URL: ${this.getWebSocketUrl()}`);
        console.log(`   Devices Dir: ${this.devicesDir}`);
        console.log(`   Setup Dir: ${this.setupDir}`);
    }
}

module.exports = new Config();