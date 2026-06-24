import * as mqtt from 'mqtt';
import { privateKeyToAccount } from 'viem/accounts';
import { eip712Domain, eip712Types } from './verifier';

// Connect to local or target MQTT Broker
const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const client = mqtt.connect(BROKER_URL);

// Mock private key (never hardcode in production, load from secure hardware/env)
const PRIVATE_KEY = (process.env.DEVICE_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as `0x${string}`;
const account = privateKeyToAccount(PRIVATE_KEY);
const deviceAddress = account.address;

console.log(`[Publisher] Device active at address: ${deviceAddress}`);

client.on('connect', async () => {
  console.log(`[Publisher] Connected to broker: ${BROKER_URL}`);

  let seq = 0;
  const topic = `arra/v1/telemetry/${deviceAddress}/temperature`;

  // Publish a signed message every 5 seconds
  setInterval(async () => {
    const ts = Math.floor(Date.now() / 1000);
    const data = JSON.stringify({ temp: 24.5 + Math.random() * 2, humidity: 60 });
    seq++;

    console.log(`[Publisher] Signing packet seq: ${seq}`);

    // Create EIP-712 signature of the payload
    const signature = await account.signTypedData({
      domain: eip712Domain,
      types: eip712Types,
      primaryType: 'Telemetry',
      message: {
        from: deviceAddress,
        topic,
        ts: BigInt(ts),
        seq: BigInt(seq),
        data,
      },
    });

    // Message Envelope containing both raw data and verifying signature
    const envelope = {
      from: deviceAddress,
      topic,
      ts,
      seq,
      data,
      signature,
    };

    client.publish(topic, JSON.stringify(envelope), { qos: 1 }, (err) => {
      if (err) {
        console.error('[Publisher] Failed to publish message:', err);
      } else {
        console.log(`[Publisher] Published signed message to ${topic}`);
      }
    });
  }, 5000);
});

client.on('error', (err) => {
  console.error('[Publisher] Connection error:', err);
});
