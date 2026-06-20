import { verifyTypedData } from 'viem';
import { keccak256, stringToHex } from 'viem';
import * as mqtt from 'mqtt';
import * as fs from 'fs';
import * as path from 'path';

// EIP-712 Domain Definition
const domain = {
  name: 'ARRA-MQTT',
  version: '1',
  chainId: 20260619,
} as const;

// EIP-712 Types Definition
const types = {
  Message: [
    { name: 'from', type: 'address' },
    { name: 'ts', type: 'uint64' },
    { name: 'topic', type: 'string' },
    { name: 'dataHash', type: 'bytes32' },
    { name: 'seq', type: 'uint64' },
  ],
} as const;

interface ArraMQMessage {
  from: string;
  ts: number;
  topic: string;
  data: any;
  seq: string;
  sig: `0x${string}`;
}

const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const client = mqtt.connect(MQTT_URL);

// Persistent sequence store (survives subscriber restarts / crashes)
const SEQ_STORE_FILE = path.join(__dirname, 'seq_store.json');
let lastSeenSeq: Record<string, string> = {};

if (fs.existsSync(SEQ_STORE_FILE)) {
  try {
    lastSeenSeq = JSON.parse(fs.readFileSync(SEQ_STORE_FILE, 'utf8'));
  } catch (e) {
    lastSeenSeq = {};
  }
}

function saveLastSeenSeq(publisher: string, seq: bigint) {
  lastSeenSeq[publisher.toLowerCase()] = seq.toString();
  try {
    fs.writeFileSync(SEQ_STORE_FILE, JSON.stringify(lastSeenSeq, null, 2));
  } catch (err) {
    console.error('[Verifier] Failed to persist sequence number store:', err);
  }
}

// Simple Authorization Allowlist (ACL mapping topic to authorized Ethereum addresses)
const authorizedPublishers: Record<string, string[]> = {
  'sensor/no10/temperature': [
    '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', // Hardhat Account #0 (matching private key used in publisher.ts)
  ].map(addr => addr.toLowerCase())
};

async function verifyMessagePayload(topic: string, message: ArraMQMessage): Promise<boolean> {
  const currentTs = Math.floor(Date.now() / 1000);
  const publisher = message.from.toLowerCase();
  const seq = BigInt(message.seq);

  // 1. Strict Freshness check: reject stale messages AND future timestamps (pre-signing)
  const skew = currentTs - message.ts;
  if (skew < 0 || skew > 30) {
    console.error(`[Verifier] Rejected: Invalid timestamp skew (skew: ${skew}s). Must be between 0s and 30s.`);
    return false;
  }

  // 2. Persistent Monotonic Sequence check: reject duplicate or out-of-order sequence replays
  const lastSeqStr = lastSeenSeq[publisher];
  if (lastSeqStr !== undefined) {
    const lastSeq = BigInt(lastSeqStr);
    if (seq <= lastSeq) {
      console.error(`[Verifier] Rejected: Replay attack detected. Sequence ${seq} is not greater than last seen ${lastSeq}`);
      return false;
    }
  }

  // 3. Topic binding check: ensure topic in signed payload matches the actual target topic
  if (topic !== message.topic) {
    console.error(`[Verifier] Rejected: Topic mismatch. Subscribed topic: ${topic}, Signed: ${message.topic}`);
    return false;
  }

  // 4. Authorization check: ensure publisher is allowed to write to this topic
  const allowedAddrs = authorizedPublishers[topic];
  if (!allowedAddrs || !allowedAddrs.includes(publisher)) {
    console.error(`[Verifier] Rejected: Publisher ${message.from} is not authorized for topic ${topic}`);
    return false;
  }

  // 5. EIP-712 Typed Data cryptographic signature verification
  const dataStr = JSON.stringify(message.data);
  const dataHash = keccak256(stringToHex(dataStr));

  try {
    const isValid = await verifyTypedData({
      address: message.from as `0x${string}`,
      domain,
      types,
      primaryType: 'Message',
      message: {
        from: message.from as `0x${string}`,
        ts: BigInt(message.ts),
        topic: message.topic,
        dataHash,
        seq,
      },
      signature: message.sig,
    });

    if (isValid) {
      // Record sequence number to persistent store
      saveLastSeenSeq(publisher, seq);
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
      console.log(`[Subscriber] ✅ Message VALIDATED. Publisher: ${rawMessage.from} | Sequence: ${rawMessage.seq}`);
      console.log(`[Subscriber] Data:`, JSON.stringify(rawMessage.data));
    } else {
      console.warn(`[Subscriber] ❌ Message REJECTED. Signature invalid, stale, or replayed.`);
    }
  } catch (err) {
    console.error('[Subscriber] Error parsing message JSON payload:', err);
  }
});

client.on('error', (err) => {
  console.error('[Subscriber] MQTT Error:', err);
});
