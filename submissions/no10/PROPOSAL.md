# ARRA-MQ: EIP-712 End-to-End Cryptographic Message Broker Network

**Proposal by No.10 X (Back-end Dev & Ops, Oracle Council)**

---

## 1. Executive Summary

Traditional MQTT authentication relies on transport-level security (TLS/SSL) and broker-level access control lists (ACLs). While effective for client-to-broker trust, these models fail in decentralized, multi-hop, or bridged IoT topologies where intermediate brokers (bridges) or middleboxes can inspect, alter, or spoof messages.

**ARRA-MQ** shifts the security boundary from the **broker** to the **message**. By embedding cryptographic signatures (EIP-712 / ECDSA) directly into the message payload, ARRA-MQ ensures end-to-end (E2E) integrity, authenticity, and non-repudiation. The broker network acts purely as a stateless transit pipe, enabling flexible bridging and cloud clustering without requiring complex custom auth plugins or database synchronization at the broker layer.

---

## 2. Architecture Overview

ARRA-MQ employs a decentralized bridge topology, running lightweight brokers (Eclipse Mosquitto or NanoMQ) at the edge and bridging messages to a central EMQX cluster.

```
+-----------------------------+
|    Edge Device / ESP32      |
|  (signs payload via Wallet) |
+-----------------------------+
               │ (Local MQTT)
               ▼
+-----------------------------+
|  Edge Broker (Mosquitto)    |
+-----------------------------+
               │ (MQTT Bridge over TLS)
               ▼
+-----------------------------+
|   Central EMQX Cluster      |
+-----------------------------+
               │
               ▼
+-----------------------------+
|   Application Subscriber    |
| (stateless signature check) |
+-----------------------------+
```

### Key Components:
1. **Edge Device (Publisher)**: Signs every message payload locally using an Ethereum private key (managed by a software wallet or hardware secure element like an ATECC608 chip on ESP32) using EIP-712.
2. **Edge Broker (Mosquitto/NanoMQ)**: A lightweight local broker running near the sensors. It requires zero configuration modifications to handle signatures.
3. **Bridge Connection**: Edge brokers use standard MQTT bridges to push local topics to the central EMQX Hub.
4. **Central EMQX Hub**: A highly scalable broker clustering layer. It does not run CPU-intensive signature verification hooks, maximizing throughput.
5. **Subscriber (Verifier)**: Decoupled application layer services that verify the EIP-712 signature against the publisher's address and keep a persistent sequence database to enforce security policies.

---

## 3. Cryptographic Message Format (EIP-712)

We use the EIP-712 standard to sign structured typed data. This ensures domain separation, preventing cross-domain replay attacks, and allows standard hardware security modules to easily compute signatures.

### JSON Payload Schema
```typescript
interface ArraMQMessage {
  from: string;    // Publisher Ethereum address (0x...)
  ts: number;      // Unix timestamp in seconds
  topic: string;   // Original target topic to prevent topic-spoofing
  data: object;    // The actual payload data
  seq: string;     // Monotonic sequence number (as string to prevent JS bigint overflow)
  sig: string;     // Hex-encoded EIP-712 signature
}
```

### EIP-712 Typed Data Specifications

#### Domain Separation:
```typescript
const domain = {
  name: 'ARRA-MQTT',
  version: '1',
  chainId: 20260619,
} as const;
```

#### Types Structure:
```typescript
const types = {
  Message: [
    { name: 'from', type: 'address' },
    { name: 'ts', type: 'uint64' },
    { name: 'topic', type: 'string' },
    { name: 'dataHash', type: 'bytes32' },
    { name: 'seq', type: 'uint64' },
  ],
} as const;
```

---

## 4. Threat Mitigation Analysis

| Threat Vector | Attack Scenario | ARRA-MQ Mitigation |
| :--- | :--- | :--- |
| **Broker Compromise** | Attacker gains control of the central EMQX instance or an edge broker and attempts to inject fake telemetry. | **Mitigated**: The verifier validates the signature AND checks the publisher address against an explicit **Authorization Allowlist** (ACL) for the given topic. |
| **Topic Spoofing / Relaying** | Attacker intercepts a valid message on `topic A` and replays it on `topic B`. | **Mitigated**: The target `topic` is included in the signed EIP-712 payload. Verifier rejects if `topic` in signed payload !== actual MQTT topic. |
| **Replay Attacks** | Attacker intercepts a valid message (e.g., "turn on heater") and re-publishes it. | **Mitigated**: Verifiers implement **Strict Skew Filtering** (rejecting future timestamps and skew > 30s) + a **Persistent Monotonic Sequence Store** (persisting last seen sequences per sender address to survive verifier restarts/crashes). |
| **Pre-Signing Attacks** | Attacker gains temporary physical access to a device, generates 10,000 signed payloads with future timestamps, and schedules them for later execution. | **Mitigated**: Rejecting future timestamps (negative skew) prevents simple pre-signing. For critical control topics, the signed data requires a rotating **Server Epoch Nonce** (rotating every 10 min, fetched via a secure endpoint or periodic broadcast). |

---

## 5. Viem-based Implementation (JS/TS)

Below is the complete implementation for publisher signing and subscriber verification using the `viem` library.

### 5.1 Publisher Client (`publisher.ts`)
```typescript
import { privateKeyToAccount } from 'viem/accounts';
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
  sig: string;
}

const PRIVATE_KEY = process.env.PUBLISHER_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // standard hardhat account 0
const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const client = mqtt.connect(MQTT_URL);

// Load and persist sequence number to survive publisher restarts
const SEQ_FILE = path.join(__dirname, 'publisher_seq.json');
let currentSeq = 0n;
if (fs.existsSync(SEQ_FILE)) {
  try {
    currentSeq = BigInt(JSON.parse(fs.readFileSync(SEQ_FILE, 'utf8')).seq);
  } catch (e) {
    currentSeq = 0n;
  }
}

function saveSeq(seq: bigint) {
  try {
    fs.writeFileSync(SEQ_FILE, JSON.stringify({ seq: seq.toString() }));
  } catch (err) {
    console.error('[Publisher] Failed to persist sequence number:', err);
  }
}

async function publishMessage(topic: string, data: object) {
  const ts = Math.floor(Date.now() / 1000);
  
  // Hash the payload data to a bytes32 hash to include in the EIP-712 struct
  const dataStr = JSON.stringify(data);
  const dataHash = keccak256(stringToHex(dataStr));

  // Increment and persist sequence
  currentSeq++;
  saveSeq(currentSeq);

  // Sign EIP-712 Typed Data
  const sig = await account.signTypedData({
    domain,
    types,
    primaryType: 'Message',
    message: {
      from: account.address,
      ts: BigInt(ts),
      topic,
      dataHash,
      seq: currentSeq,
    },
  });

  const messagePayload: ArraMQMessage = {
    from: account.address,
    ts,
    topic,
    data,
    seq: currentSeq.toString(),
    sig,
  };

  client.publish(topic, JSON.stringify(messagePayload));
  console.log(`[Publisher] Published EIP-712 signed message to ${topic}`);
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
```

### 5.2 Subscriber Verifier (`subscriber.ts`)
```typescript
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
  client.subscribe(targetTopic);
});

client.on('message', async (topic, payload) => {
  try {
    const rawMessage = JSON.parse(payload.toString()) as ArraMQMessage;
    const isValid = await verifyMessagePayload(topic, rawMessage);
    
    if (isValid) {
      console.log(`[VALIDATED] From: ${rawMessage.from} | Data:`, rawMessage.data);
      // Proceed with business logic here
    } else {
      console.warn(`[WARNING] Dropped invalid or forged message on topic: ${topic}`);
    }
  } catch (err) {
    console.error('Failed to parse incoming payload:', err);
  }
});
```

---

## 6. Implementation & Deployment Blueprint

1. **Step 1**: Build the node-based SDK wrapper for ESP32 and Node.js clients under `submissions/no10/examples/`.
2. **Step 2**: Deploy a local Eclipse Mosquitto test container utilizing default parameters (anonymous mode allowed at edge, security verified strictly at application).
3. **Step 3**: Configure the MQTT Bridge section of Mosquitto to establish connection to the centralized EMQX hub.
4. **Step 4**: Implement the verification logic inside our L2 Paymaster/Sequencer indexer daemon to ingest edge events securely.

---

*Submitted by No.10 X — Oracle Council, Workshop 07 ARRA-MQ*
🤖 No.10 X จาก ai-core
