// ARRA-MQ Client Subscriber & Verifier (Bun/Node.js)
// Enforces EIP-712 Typed Signature Verification, Topic-Binding, and Persisted Sequence checks.
// Dependencies: npm i mqtt viem

import mqtt from 'mqtt';
import fs from 'fs';
import path from 'path';
import { recoverTypedDataAddress } from 'viem';

const BROKER_URL = 'mqtt://localhost:1883';
const subscribeTopic = 'device/+/telemetry';

// Drift threshold in seconds
const TIME_DRIFT_LIMIT = 30;

// 1. Establish EIP-712 Schema
const domain = {
  name: 'ARRA-MQTT',
  version: '1',
  chainId: 20260619 // ARRA Oracle Blockchain L2 Chain ID
} as const;

const types = {
  ArraMQMessage: [
    { name: 'from', type: 'address' },
    { name: 'topic', type: 'string' },
    { name: 'ts', type: 'uint64' },
    { name: 'seq', type: 'uint64' },
    { name: 'data', type: 'string' }
  ]
} as const;

// 2. Persisted Sequence Number Storage Layer
// (Demo uses local JSON file; Production should swap this with Redis)
class SequenceStore {
  private filePath: string;
  private store: Record<string, number> = {};

  constructor() {
    this.filePath = path.join(__dirname, 'seq_store.json');
    this.loadStore();
  }

  private loadStore() {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this.store = JSON.parse(raw);
        console.log(`✓ Loaded persisted sequence store (${Object.keys(this.store).length} devices cached)`);
      } catch (e) {
        console.warn('⚠️ Failed to load seq_store.json, initializing empty:', e);
        this.store = {};
      }
    }
  }

  private saveStore() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.store, null, 2), 'utf8');
    } catch (e) {
      console.error('⚠️ Failed to persist sequence store:', e);
    }
  }

  // Get last verified sequence number for a device
  getLastSeq(address: string): number {
    return this.store[address.toLowerCase()] || 0;
  }

  // Save/update the sequence number
  updateSeq(address: string, seq: number) {
    this.store[address.toLowerCase()] = seq;
    this.saveStore(); // Flush to disk for durability (In production: REDIS SET)
  }
}

const db = new SequenceStore();

console.log(`Connecting to ARRA-MQ Broker at ${BROKER_URL}...`);
const client = mqtt.connect(BROKER_URL);

client.on('connect', () => {
  console.log(`✓ Connected. Subscribing to ${subscribeTopic}...`);
  client.subscribe(subscribeTopic);
});

client.on('message', async (topic, messageBuffer) => {
  const rawMessage = messageBuffer.toString();
  console.log(`\n========================================`);
  console.log(`[RECEIVED] Topic: ${topic}`);

  try {
    const envelope = JSON.parse(rawMessage);
    const { from, ts, seq, data, sig } = envelope;

    if (!from || !ts || !seq || !data || !sig) {
      console.error('❌ [DROP] Message structure is missing required parameters.');
      return;
    }

    // 1. Time Drift Check (Stateless freshness window)
    const now = Math.floor(Date.now() / 1000);
    const drift = Math.abs(now - ts);
    if (drift > TIME_DRIFT_LIMIT) {
      console.error(`❌ [DROP] Time drift check failed: drift of ${drift}s is larger than ${TIME_DRIFT_LIMIT}s limit.`);
      return;
    }

    // 2. Topic-Binding Check (Prevents broker-level topic-rerouting attacks)
    if (topic.toLowerCase() !== envelope.topic.toLowerCase()) {
      console.error(`❌ [DROP] Topic-binding validation failed! Actual topic is "${topic}" but signature binds "${envelope.topic}"`);
      return;
    }

    // 3. EIP-712 Signature Recovery
    const recoveredAddress = await recoverTypedDataAddress({
      domain,
      types,
      primaryType: 'ArraMQMessage',
      message: {
        from,
        topic: envelope.topic, // Sign binds topic
        ts: BigInt(ts),
        seq: BigInt(seq),
        data
      },
      signature: sig
    });

    if (recoveredAddress.toLowerCase() !== from.toLowerCase()) {
      console.error(`❌ [DROP] Signature recovery failed. Recovered signer address is ${recoveredAddress} but envelope claims ${from}`);
      return;
    }

    // 4. Persisted Monotonic Sequence Number Check (Replay protection)
    const lastSeq = db.getLastSeq(from);
    if (seq <= lastSeq) {
      console.error(`❌ [DROP] Replay check failed. Sequence number ${seq} is not larger than last verified sequence ${lastSeq}`);
      return;
    }

    // Mark as validated & update persistent store
    db.updateSeq(from, seq);

    console.log(`✅ [VERIFIED] Authenticity & Integrity validated successfully!`);
    console.log(`   Sender Wallet : ${from}`);
    console.log(`   Sequence      : ${seq} (Persisted: ${lastSeq} -> ${seq})`);
    console.log(`   Data Payload  :`, JSON.parse(data));

  } catch (error: any) {
    console.error('❌ [DROP] Failed to parse or verify message payload:', error.message);
  }
});
