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
