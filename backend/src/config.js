const dotenv = require('dotenv');

dotenv.config();

// Default configuration
const defaults = {
  // MQTT Connection
  MQTT_URL: 'wss://subscriber.dutchmeshcore.nl:443',
  MQTT_TOPIC: 'meshcore/+/+/packets',
  MQTT_USER: '',
  MQTT_PASSWORD: '',
  MQTT_NAME: 'sfswitch-mqtt',
  
  // Backend Server
  BACKEND_PORT: 3000,
  BACKEND_HOST: '0.0.0.0',
  
  // WebSocket
  WS_PORT: 3001,
  
  // Data Store
  PACKET_BUFFER_SIZE: 10000,
  AGGREGATION_WINDOW: 60, // seconds
  
  // Optional Features
  PARSE_RAW_PACKETS: false, // Disabled by default for performance
  PERSISTENCE_FILE: '/data/packets.db',
  
  // Observer timeout (seconds without packets to mark as offline)
  OBSERVER_TIMEOUT: 300,
};

// Validate required MQTT config
const required = ['MQTT_URL', 'MQTT_TOPIC', 'MQTT_USER', 'MQTT_PASSWORD'];
for (const key of required) {
  if (!process.env[key] && !defaults[key]) {
    throw new Error(`Missing required configuration: ${key}`);
  }
}

// Merge with environment variables (env takes precedence)
const config = { ...defaults };
for (const key in defaults) {
  if (process.env[key] !== undefined) {
    // Convert numeric strings to numbers
    if (['BACKEND_PORT', 'WS_PORT', 'PACKET_BUFFER_SIZE', 'AGGREGATION_WINDOW', 'OBSERVER_TIMEOUT'].includes(key)) {
      config[key] = Number(process.env[key]);
    } else if (['PARSE_RAW_PACKETS'].includes(key)) {
      config[key] = process.env[key] === 'true';
    } else {
      config[key] = process.env[key];
    }
  }
}

module.exports = config;
