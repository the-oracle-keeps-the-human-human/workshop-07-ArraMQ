import { verifyMessage } from 'viem';
import * as mqtt from 'mqtt';

interface ArraMQMessage {
  from: string;
  ts: number;
  topic: string;
  data: any;
  sig: `0x${string}`;
}

const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const client = mqtt.connect(MQTT_URL);

async function verifyMessagePayload(topic: string, message: ArraMQMessage): Promise<boolean> {
  const currentTs = Math.floor(Date.now() / 1000);
  
  // 1. Freshness check: reject if message was signed more than 30 seconds ago/skew is too large
  const skew = Math.abs(currentTs - message.ts);
  if (skew > 30) {
    console.error(`[Verifier] Rejected: Message expired. Skew: ${skew}s`);
    return false;
  }

  // 2. Topic binding check: ensure topic in signed payload matches the actual topic
  if (topic !== message.topic) {
    console.error(`[Verifier] Rejected: Topic mismatch. Subscribed topic: ${topic}, Signed: ${message.topic}`);
    return false;
  }

  // 3. EIP-191 Signature check
  const signText = `ARRA-MQTT/v1\nAddress: ${message.from}\nTimestamp: ${message.ts}\nTopic: ${message.topic}\nPayload: ${JSON.stringify(message.data)}`;
  
  try {
    const isValid = await verifyMessage({
      address: message.from as `0x${string}`,
      message: signText,
      signature: message.sig,
    });
    return isValid;
  } catch (error) {
    console.error('[Verifier] Cryptographic verification failed:', error);
    return false;
  }
}

client.on('connect', () => {
  const targetTopic = 'sensor/no10/temperature';
  console.log('[Subscriber] Connected to MQTT Broker:', MQTT_URL);
  
  client.subscribe(targetTopic, () => {
    console.log(`[Subscriber] Subscribed to topic: ${targetTopic}`);
  });
});

client.on('message', async (topic, payload) => {
  try {
    const rawMessage = JSON.parse(payload.toString()) as ArraMQMessage;
    console.log(`\n[Subscriber] Received message on topic [${topic}]`);
    
    const isValid = await verifyMessagePayload(topic, rawMessage);
    
    if (isValid) {
      console.log(`[Subscriber] ✅ Message VALIDATED. Publisher: ${rawMessage.from}`);
      console.log(`[Subscriber] Data:`, JSON.stringify(rawMessage.data));
    } else {
      console.warn(`[Subscriber] ❌ Message REJECTED. Signature invalid, stale, or spoofed.`);
    }
  } catch (err) {
    console.error('[Subscriber] Error parsing message JSON payload:', err);
  }
});

client.on('error', (err) => {
  console.error('[Subscriber] MQTT Error:', err);
});
