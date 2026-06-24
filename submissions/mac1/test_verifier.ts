import { verifyTelemetryMessage, eip712Domain, eip712Types } from './verifier';
import { privateKeyToAccount } from 'viem/accounts';
import * as fs from 'fs';
import * as path from 'path';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const account = privateKeyToAccount(PRIVATE_KEY);
const from = account.address;

const SEQ_STORE_FILE = path.join(__dirname, 'seq_store.json');

// Cleanup helper
function cleanup() {
  if (fs.existsSync(SEQ_STORE_FILE)) {
    fs.unlinkSync(SEQ_STORE_FILE);
  }
}

async function runTests() {
  console.log('--- Starting ARRA-MQ Verifier Tests ---');
  cleanup();

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`[PASS] ${msg}`);
      passed++;
    } else {
      console.error(`[FAIL] ${msg}`);
      failed++;
    }
  }

  const topic = `arra/v1/telemetry/${from}/temperature`;
  const data = JSON.stringify({ temp: 25.4 });

  // 1. Test Valid Message
  {
    const ts = Math.floor(Date.now() / 1000);
    const seq = 1;
    const signature = await account.signTypedData({
      domain: eip712Domain,
      types: eip712Types,
      primaryType: 'Telemetry',
      message: { from, topic, ts: BigInt(ts), seq: BigInt(seq), data }
    });

    const envelope = { from, topic, ts, seq, data, signature };
    const isValid = await verifyTelemetryMessage(envelope, topic);
    assert(isValid === true, 'Valid message accepted');
  }

  // 2. Test Tampered Data (Bad Signature)
  {
    const ts = Math.floor(Date.now() / 1000);
    const seq = 2;
    const signature = await account.signTypedData({
      domain: eip712Domain,
      types: eip712Types,
      primaryType: 'Telemetry',
      message: { from, topic, ts: BigInt(ts), seq: BigInt(seq), data }
    });

    const envelope = { from, topic, ts, seq, data: '{"temp": 99.9}', signature }; // Tampered data
    const isValid = await verifyTelemetryMessage(envelope, topic);
    assert(isValid === false, 'Tampered data rejected');
  }

  // 3. Test Rerouted Topic
  {
    const ts = Math.floor(Date.now() / 1000);
    const seq = 3;
    const signature = await account.signTypedData({
      domain: eip712Domain,
      types: eip712Types,
      primaryType: 'Telemetry',
      message: { from, topic, ts: BigInt(ts), seq: BigInt(seq), data }
    });

    const envelope = { from, topic, ts, seq, data, signature };
    const actualDeliveryTopic = `arra/v1/telemetry/${from}/humidity`; // Rerouted topic
    const isValid = await verifyTelemetryMessage(envelope, actualDeliveryTopic);
    assert(isValid === false, 'Rerouted topic rejected');
  }

  // 4. Test Replayed Sequence
  {
    const ts = Math.floor(Date.now() / 1000);
    const seq = 1; // Already processed in test 1
    const signature = await account.signTypedData({
      domain: eip712Domain,
      types: eip712Types,
      primaryType: 'Telemetry',
      message: { from, topic, ts: BigInt(ts), seq: BigInt(seq), data }
    });

    const envelope = { from, topic, ts, seq, data, signature };
    const isValid = await verifyTelemetryMessage(envelope, topic);
    assert(isValid === false, 'Replayed sequence rejected');
  }

  // 5. Test Stale Timestamp
  {
    const ts = Math.floor(Date.now() / 1000) - 20; // 20 seconds drift (drift limit: 10s)
    const seq = 4;
    const signature = await account.signTypedData({
      domain: eip712Domain,
      types: eip712Types,
      primaryType: 'Telemetry',
      message: { from, topic, ts: BigInt(ts), seq: BigInt(seq), data }
    });

    const envelope = { from, topic, ts, seq, data, signature };
    const isValid = await verifyTelemetryMessage(envelope, topic);
    assert(isValid === false, 'Stale timestamp rejected');
  }

  // 6. Test Restart Persistence (Simulate reload of sequence from disk)
  {
    // Let's create an envelope with a higher sequence first, and process it
    const ts = Math.floor(Date.now() / 1000);
    const seq = 5;
    const signature = await account.signTypedData({
      domain: eip712Domain,
      types: eip712Types,
      primaryType: 'Telemetry',
      message: { from, topic, ts: BigInt(ts), seq: BigInt(seq), data }
    });

    const envelope = { from, topic, ts, seq, data, signature };
    const isValid = await verifyTelemetryMessage(envelope, topic);
    assert(isValid === true, 'Sequence 5 accepted');

    // Simulate "restart" by creating a fresh check of sequence 5 (must read from JSON file)
    // We will try to replay sequence 5
    const ts2 = Math.floor(Date.now() / 1000);
    const signatureReplay = await account.signTypedData({
      domain: eip712Domain,
      types: eip712Types,
      primaryType: 'Telemetry',
      message: { from, topic, ts: BigInt(ts2), seq: BigInt(5), data }
    });
    const envelopeReplay = { from, topic, ts: ts2, seq: 5, data, signature: signatureReplay };
    const isValidReplay = await verifyTelemetryMessage(envelopeReplay, topic);
    assert(isValidReplay === false, 'Persistent sequence 5 replay rejected after simulated restart');
  }

  // 7. Test Higher Sequence Accepted
  {
    const ts = Math.floor(Date.now() / 1000);
    const seq = 6;
    const signature = await account.signTypedData({
      domain: eip712Domain,
      types: eip712Types,
      primaryType: 'Telemetry',
      message: { from, topic, ts: BigInt(ts), seq: BigInt(seq), data }
    });

    const envelope = { from, topic, ts, seq, data, signature };
    const isValid = await verifyTelemetryMessage(envelope, topic);
    assert(isValid === true, 'Higher sequence 6 accepted');
  }

  console.log(`\n--- Test Results: ${passed} passed, ${failed} failed ---`);
  cleanup();
}

runTests().catch(console.error);
