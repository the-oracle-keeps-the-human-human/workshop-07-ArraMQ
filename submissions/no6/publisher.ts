// ARRA-MQ Client Publisher (Bun/Node.js)
// Dependencies: npm i mqtt viem

import mqtt from 'mqtt';
import { privateKeyToAccount } from 'viem/accounts';

// Private key for testing (simulate IoT device wallet)
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Anvil account #0
const account = privateKeyToAccount(PRIVATE_KEY);
const clientAddress = account.address;

const BROKER_URL = 'mqtt://localhost:1883';
const targetTopic = `device/${clientAddress.toLowerCase()}/telemetry`;

// 1. Establish EIP-712 Domain & Types
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

// 2. Setup MQTT Client and sign connection token (Time-Based SIWE Connect)
const connectTimestamp = Math.floor(Date.now() / 1000);
const connectMessage = `SIWE-MQTT Connect: ${clientAddress.toLowerCase()} at ${connectTimestamp}`;

async function main() {
  console.log(`signing connection token...`);
  const connectSignature = await account.signMessage({ message: connectMessage });
  const password = `${connectTimestamp}:${connectSignature}`;

  console.log(`Connecting to ARRA-MQ Broker at ${BROKER_URL}...`);
  const client = mqtt.connect(BROKER_URL, {
    username: clientAddress,
    password: password,
    clientId: `arra_client_${clientAddress.substring(0, 8)}`
  });

  let seq = 1n;

  client.on('connect', () => {
    console.log('✓ Connected to Broker.');

    // Publish telemetry every 5 seconds
    setInterval(async () => {
      const dataPayload = { temperature: 24.5 + Math.random(), status: "OK" };
      const rawDataString = JSON.stringify(dataPayload);
      const timestamp = BigInt(Math.floor(Date.now() / 1000));

      const messageToSign = {
        from: clientAddress,
        topic: targetTopic,
        ts: timestamp,
        seq: seq,
        data: rawDataString
      };

      console.log(`\n--- Sending Message #${seq} ---`);
      console.log(`Target Topic: ${targetTopic}`);

      // Sign message with EIP-712 typed data
      const signature = await account.signTypedData({
        domain,
        types,
        primaryType: 'ArraMQMessage',
        message: messageToSign
      });

      const envelope = {
        ...messageToSign,
        // Convert BigInt to string/number for JSON compatibility
        ts: Number(timestamp),
        seq: Number(seq),
        sig: signature
      };

      client.publish(targetTopic, JSON.stringify(envelope), { qos: 1 }, (err) => {
        if (err) {
          console.error('Publish error:', err);
        } else {
          console.log(`✓ Published with EIP-712 Signature: ${signature}`);
        }
      });

      seq++;
    }, 5000);
  });

  client.on('error', (err) => {
    console.error('Connection error:', err);
  });
}

main().catch(console.error);
