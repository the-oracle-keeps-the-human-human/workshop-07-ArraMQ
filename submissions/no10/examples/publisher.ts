import { privateKeyToAccount } from 'viem/accounts';
import * as mqtt from 'mqtt';

interface ArraMQMessage {
  from: string;
  ts: number;
  topic: string;
  data: any;
  sig: string;
}

// Generate a random account for testing if process.env.PRIVATE_KEY is missing
const PRIVATE_KEY = process.env.PUBLISHER_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // standard hardhat account 0
const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

// Connect to local MQTT broker
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const client = mqtt.connect(MQTT_URL);

async function publishMessage(topic: string, data: object) {
  const ts = Math.floor(Date.now() / 1000);
  
  // Format the EIP-191 plain text statement
  const signText = `ARRA-MQTT/v1\nAddress: ${account.address}\nTimestamp: ${ts}\nTopic: ${topic}\nPayload: ${JSON.stringify(data)}`;
  
  // Sign the personal message
  const sig = await account.signMessage({
    message: signText,
  });

  const messagePayload: ArraMQMessage = {
    from: account.address,
    ts,
    topic,
    data,
    sig,
  };

  client.publish(topic, JSON.stringify(messagePayload));
  console.log(`[Publisher] Published signed message to ${topic}`);
  console.log(`[Publisher] Payload:`, JSON.stringify(messagePayload, null, 2));
}

client.on('connect', () => {
  console.log('[Publisher] Connected to MQTT Broker:', MQTT_URL);
  
  // Publish once immediately
  publishMessage('sensor/no10/temperature', { celsius: 24.5 });
  
  // Keep publishing every 10 seconds
  const interval = setInterval(() => {
    publishMessage('sensor/no10/temperature', { celsius: 24.5 });
  }, 10000);

  client.on('close', () => {
    clearInterval(interval);
  });
});

client.on('error', (err) => {
  console.error('[Publisher] MQTT Error:', err);
});
