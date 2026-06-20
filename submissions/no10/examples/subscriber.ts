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

// In-memory seen signatures cache to prevent duplicate verbatim replay within the skew window
const seenSignatures = new Map<string, number>(); // sig -> timestamp (seconds)

// Periodic cleanup of expired signatures from the cache
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [sig, ts] of seenSignatures.entries()) {
    if (now - ts > 30) {
      seenSignatures.delete(sig);
    }
  }
}, 10000);

// Simple Authorization Allowlist (ACL mapping topic to authorized Ethereum addresses)
const authorizedPublishers: Record<string, string[]> = {
  'sensor/no10/temperature': [
    '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', // Hardhat Account #0 (matching private key used in publisher.ts)
  ].map(addr => addr.toLowerCase())
};

async function verifyMessagePayload(topic: string, message: ArraMQMessage): Promise<boolean> {
  const currentTs = Math.floor(Date.now() / 1000);
  
  // 1. Strict Freshness check: reject stale messages AND future timestamps (pre-signing)
  const skew = currentTs - message.ts;
  if (skew < 0 || skew > 30) {
    console.error(`[Verifier] Rejected: Invalid timestamp skew (skew: ${skew}s). Must be between 0s and 30s.`);
    return false;
  }

  // 2. Signature seen-cache check: prevent duplicate replay of the exact same message inside the window
  if (seenSignatures.has(message.sig)) {
    console.error(`[Verifier] Rejected: Replay attack detected. Signature already processed.`);
    return false;
  }

  // 3. Topic binding check: ensure topic in signed payload matches the actual target topic
  if (topic !== message.topic) {
    console.error(`[Verifier] Rejected: Topic mismatch. Subscribed topic: ${topic}, Signed: ${message.topic}`);
    return false;
  }

  // 4. Authorization check: ensure publisher is allowed to write to this topic
  const allowedAddrs = authorizedPublishers[topic];
  if (!allowedAddrs || !allowedAddrs.includes(message.from.toLowerCase())) {
    console.error(`[Verifier] Rejected: Publisher ${message.from} is not authorized for topic ${topic}`);
    return false;
  }

  // 5. EIP-191 Cryptographic Signature verification
  const signText = `ARRA-MQTT/v1\nAddress: ${message.from}\nTimestamp: ${message.ts}\nTopic: ${message.topic}\nPayload: ${JSON.stringify(message.data)}`;
  
  try {
    const isValid = await verifyMessage({
      address: message.from as `0x${string}`,
      message: signText,
      signature: message.sig,
    });

    if (isValid) {
      // Record signature in cache to prevent replay
      seenSignatures.set(message.sig, message.ts);
      return true;
    }
    return false;
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
