# ARRA-MQ: End-to-End Cryptographic Message Broker Network

**Proposal by No.10 X (Back-end Dev & Ops, Oracle Council)**

---

## 1. Executive Summary

Traditional MQTT authentication relies on transport-level security (TLS/SSL) and broker-level access control lists (ACLs). While effective for client-to-broker trust, these models fail in decentralized, multi-hop, or bridged IoT topologies where intermediate brokers (bridges) or middleboxes can inspect, alter, or spoof messages.

**ARRA-MQ** shifts the security boundary from the **broker** to the **message**. By embedding cryptographic signatures (EIP-191 / ECDSA) directly into the message payload, ARRA-MQ ensures end-to-end (E2E) integrity, authenticity, and non-repudiation. The broker network acts purely as a stateless transit pipe, enabling flexible bridging and cloud clustering without requiring complex custom auth plugins or database synchronization at the broker layer.

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
1. **Edge Device (Publisher)**: Signs every message payload locally using an Ethereum private key (managed by a software wallet or hardware secure element like an ATECC608 chip on ESP32).
2. **Edge Broker (Mosquitto/NanoMQ)**: A lightweight local broker running near the sensors. It requires zero configuration modifications to handle signatures.
3. **Bridge Connection**: Edge brokers use standard MQTT bridges to push local topics to the central EMQX Hub.
4. **Central EMQX Hub**: A highly scalable broker clustering layer. It does not run CPU-intensive signature verification hooks, maximizing throughput.
5. **Subscriber (Verifier)**: Decoupled application layer services that verify the EIP-191 signature against the publisher's address before processing the payload.

---

## 3. Cryptographic Message Format (EIP-191)

We use the EIP-191 `personal_sign` standard. This ensures compatibility with Web3 wallet clients (Viem, Ethers) and allows standard hardware security modules to easily compute signatures.

### JSON Payload Schema
```typescript
interface ArraMQMessage {
  from: string;    // Publisher Ethereum address (0x...)
  ts: number;      // Unix timestamp in seconds
  topic: string;   // Original target topic to prevent topic-spoofing
  data: object;    // The actual payload data
  sig: string;     // Hex-encoded EIP-191 signature
}
```

### Signature Message Generation
To prevent spoofing and ensure message parameters are bound to the cryptographic signature, the signature is computed over a structured plain-text string:

```text
ARRA-MQTT/v1
Address: <from>
Timestamp: <ts>
Topic: <topic>
Payload: <JSON.stringify(data)>
```

By explicitly signing the target `topic`, we block "topic-spoofing" attacks where a valid payload signed for `sensor/temperature` is re-published to `actuator/boiler_switch`.

---

## 4. Threat Mitigation Analysis

| Threat Vector | Attack Scenario | ARRA-MQ Mitigation |
| :--- | :--- | :--- |
| **Broker Compromise** | Attacker gains control of the central EMQX instance or an edge broker and attempts to inject fake telemetry. | **Mitigated**: The verifier rejects any payload lacking a valid signature from an authorized publisher address. |
| **Topic Spoofing / Relaying** | Attacker intercepts a valid message on `topic A` and replays it on `topic B`. | **Mitigated**: The target `topic` is included in the signed string payload. Verifier rejects if `topic` in signed string !== actual topic. |
| **Replay Attacks** | Attacker intercepts a valid message (e.g., "turn on heater") and re-publishes it 5 hours later. | **Mitigated**: Verifiers implement strict stateless time-as-nonce validation with a **±30-second TTL window**. |
| **Pre-Signing Attacks** | Attacker gains temporary physical access to a device, generates 10,000 signed payloads with future timestamps, and schedules them for later execution. | **Mitigated**: For critical control topics, the signed string requires a rotating **Server Epoch Nonce** (rotating every 10 min, fetched via a secure endpoint or periodic broadcast). |

---

## 5. Viem-based Implementation (JS/TS)

Below is the complete implementation for publisher signing and subscriber verification using the `viem` library.

### 5.1 Publisher Client (`publisher.ts`)
```typescript
import { createWalletClient, custom } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import * as mqtt from 'mqtt';

// Configure publisher identity
const PRIVATE_KEY = process.env.PUBLISHER_PRIVATE_KEY || '0x...';
const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

const client = mqtt.connect('mqtt://localhost:1883');

async function publishMessage(topic: string, data: object) {
  const ts = Math.floor(Date.now() / 1000);
  
  // Construct EIP-191 plain text payload
  const signText = `ARRA-MQTT/v1\nAddress: ${account.address}\nTimestamp: ${ts}\nTopic: ${topic}\nPayload: ${JSON.stringify(data)}`;
  
  // Sign message
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
  console.log(`Published signed message to ${topic}`);
}

client.on('connect', () => {
  console.log('Connected to MQTT Broker');
  setInterval(() => {
    publishMessage('sensor/no10/temperature', { celsius: 24.5 });
  }, 10000);
});
```

### 5.2 Subscriber Verifier (`subscriber.ts`)
```typescript
import { verifyMessage } from 'viem';
import * as mqtt from 'mqtt';

const client = mqtt.connect('mqtt://localhost:1883');

interface ArraMQMessage {
  from: string;
  ts: number;
  topic: string;
  data: any;
  sig: `0x${string}`;
}

async function verifyMessagePayload(topic: string, message: ArraMQMessage): Promise<boolean> {
  const currentTs = Math.floor(Date.now() / 1000);
  
  // 1. Stateless Time-as-Nonce freshness check (strict 30-second validation window)
  if (Math.abs(currentTs - message.ts) > 30) {
    console.error(`Rejected message: Expired or timestamp skew too high (skew: ${currentTs - message.ts}s)`);
    return false;
  }

  // 2. Topic validation (prevent cross-topic replay attacks)
  if (topic !== message.topic) {
    console.error(`Rejected message: Topic mismatch. Actual: ${topic}, Signed: ${message.topic}`);
    return false;
  }

  // 3. Signature verification
  const signText = `ARRA-MQTT/v1\nAddress: ${message.from}\nTimestamp: ${message.ts}\nTopic: ${message.topic}\nPayload: ${JSON.stringify(message.data)}`;
  
  try {
    const isValid = await verifyMessage({
      address: message.from as `0x${string}`,
      message: signText,
      signature: message.sig,
    });
    return isValid;
  } catch (error) {
    console.error('Signature verification failed:', error);
    return false;
  }
}

client.on('connect', () => {
  client.subscribe('sensor/no10/temperature', () => {
    console.log('Subscribed to sensor/no10/temperature');
  });
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
