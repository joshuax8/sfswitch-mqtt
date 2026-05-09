const mqtt = require('mqtt');
const config = require('./config');
const store = require('./store');

/**
 * MQTT Client for MeshCore packet subscription
 */
class MqttClient {
  constructor() {
    this.client = null;
    this.connected = false;
    this.subscribed = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000; // 5 seconds
  }

  connect() {
    const options = {
      clientId: `${config.MQTT_NAME}-${process.pid}-${Date.now()}`,
      username: config.MQTT_USER,
      password: config.MQTT_PASSWORD,
      clean: true,
      reconnectPeriod: this.reconnectDelay,
      connectTimeout: 30000,
      // WebSocket specific options
      protocol: 'wss',
      rejectUnauthorized: false, // Allow self-signed certs
    };

    console.log(`Connecting to MQTT broker: ${config.MQTT_URL}`);
    
    this.client = mqtt.connect(config.MQTT_URL, options);

    this.client.on('connect', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      console.log('MQTT connected');
      this.subscribe();
    });

    this.client.on('close', () => {
      this.connected = false;
      this.subscribed = false;
      console.log('MQTT connection closed');
    });

    this.client.on('error', (err) => {
      console.error('MQTT error:', err.message);
    });

    this.client.on('message', (topic, message) => {
      this.handleMessage(topic, message);
    });

    this.client.on('offline', () => {
      this.connected = false;
      console.log('MQTT client offline');
    });

    this.client.on('reconnect', () => {
      console.log('MQTT reconnecting...');
    });
  }

  subscribe() {
    if (!this.client || !this.connected) {
      return false;
    }

    console.log(`Subscribing to topic: ${config.MQTT_TOPIC}`);
    
    this.client.subscribe(config.MQTT_TOPIC, { qos: 0 }, (err) => {
      if (err) {
        console.error('Subscription error:', err.message);
        this.subscribed = false;
      } else {
        this.subscribed = true;
        console.log(`Subscribed to ${config.MQTT_TOPIC}`);
      }
    });
    
    return true;
  }

  handleMessage(topic, message) {
    try {
      // Parse JSON message
      const packet = JSON.parse(message.toString('utf8'));
      
      // Validate required fields
      if (!packet.timestamp || !packet.origin_id) {
        console.warn('Invalid packet format, missing required fields');
        return;
      }

      // Add to store
      store.addPacket(packet);

      // Optional raw parsing (disabled by default)
      if (config.PARSE_RAW_PACKETS && packet.raw) {
        this.parseRawPacket(packet);
      }
    } catch (err) {
      console.error('Error processing MQTT message:', err.message);
    }
  }

  parseRawPacket(packet) {
    // Parse MeshCore header from raw hex
    try {
      const raw = Buffer.from(packet.raw, 'hex');
      if (raw.length < 1) return;

      const header = raw[0];
      const routeType = header & 0x03;
      const payloadType = (header >> 2) & 0x0F;
      const payloadVersion = (header >> 6) & 0x03;

      packet.parsed = {
        routeType,
        payloadType,
        payloadVersion,
        rawLength: raw.length,
      };
    } catch (err) {
      console.error('Error parsing raw packet:', err.message);
    }
  }

  getStatus() {
    return {
      connected: this.connected,
      subscribed: this.subscribed,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  disconnect() {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
    this.connected = false;
    this.subscribed = false;
  }
}

// Singleton instance
const mqttClient = new MqttClient();

module.exports = mqttClient;
