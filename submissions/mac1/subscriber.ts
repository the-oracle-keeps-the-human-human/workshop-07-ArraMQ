import * as mqtt from 'mqtt';
import { verifyTelemetryMessage, TelemetryEnvelope } from './verifier';

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const client = mqtt.connect(BROKER_URL);

// Telemetry topic pattern matching any Ethereum address and sensor type
const SUBSCRIBE_TOPIC = 'arra/v1/telemetry/+/+';

client.on('connect', () => {
  console.log(`[Subscriber] Connected to broker: ${BROKER_URL}`);
  client.subscribe(SUBSCRIBE_TOPIC, { qos: 1 }, (err) => {
    if (err) {
      console.error('[Subscriber] Subscription failed:', err);
    } else {
      console.log(`[Subscriber] Subscribed to topic pattern: ${SUBSCRIBE_TOPIC}`);
    }
  });
});

client.on('message', async (topic, payload) => {
  console.log(`\n========================================`);
  console.log(`[Subscriber] Received message on topic: ${topic}`);

  try {
    const envelope = JSON.parse(payload.toString()) as TelemetryEnvelope;

    // Perform end-to-end EIP-712 signature, freshness, topic-binding, and sequence check
    const isValid = await verifyTelemetryMessage(envelope, topic);

    if (isValid) {
      console.log(`[Subscriber] ✅ MESSAGE VERIFIED SUCCESSFUL!`);
      console.log(`  Signer: ${envelope.from}`);
      console.log(`  Payload: ${envelope.data}`);
      console.log(`  Seq: ${envelope.seq} | Timestamp: ${envelope.ts}`);
    } else {
      console.error(`[Subscriber] ❌ SIGNATURE / SECURITY CHECK FAILED!`);
    }
  } catch (error) {
    console.error('[Subscriber] ❌ Failed to parse payload or verify message:', error);
  }
  console.log(`========================================`);
});

client.on('error', (err) => {
  console.error('[Subscriber] Connection error:', err);
});
