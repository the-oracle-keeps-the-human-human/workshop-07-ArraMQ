import { recoverTypedDataAddress } from 'viem';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
export const DOMAIN_NAME = 'ARRA-MQTT';
export const DOMAIN_VERSION = '1';
export const CHAIN_ID = 20260619;
export const MAX_DRIFT_SECONDS = 10; // Allowed clock drift for freshness validation

export const eip712Domain = {
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  chainId: CHAIN_ID,
};

export const eip712Types = {
  Telemetry: [
    { name: 'from', type: 'address' },
    { name: 'topic', type: 'string' },
    { name: 'ts', type: 'uint64' },
    { name: 'seq', type: 'uint64' },
    { name: 'data', type: 'string' },
  ],
};

export interface TelemetryEnvelope {
  from: `0x${string}`;
  topic: string;
  ts: number;
  seq: number;
  data: string;
  signature: `0x${string}`;
}

const SEQ_STORE_FILE = path.join(__dirname, 'seq_store.json');

/**
 * Helper to read sequence history from persistent JSON file
 */
function getSequences(): Record<string, number> {
  try {
    if (fs.existsSync(SEQ_STORE_FILE)) {
      const data = fs.readFileSync(SEQ_STORE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('[Verifier] Error reading seq_store.json:', err);
  }
  return {};
}

/**
 * Helper to update sequence history in persistent JSON file
 */
function saveSequence(address: string, seq: number) {
  try {
    const sequences = getSequences();
    sequences[address.toLowerCase()] = seq;
    fs.writeFileSync(SEQ_STORE_FILE, JSON.stringify(sequences, null, 2), 'utf8');
  } catch (err) {
    console.error('[Verifier] Error writing to seq_store.json:', err);
  }
}

/**
 * Verifies the EIP-712 signature of a telemetry message, checks for freshness, 
 * binds the topic to prevent broker-rerouting, and checks persistent sequence numbers.
 */
export async function verifyTelemetryMessage(
  envelope: TelemetryEnvelope, 
  actualDeliveryTopic: string
): Promise<boolean> {
  const { from, topic, ts, seq, data, signature } = envelope;

  // 1. Verify Topic Binding (Anti-Broker-Rerouting)
  if (topic !== actualDeliveryTopic) {
    console.warn(`[Verifier] Message rejected: Topic mismatch. Signed: "${topic}", Delivered: "${actualDeliveryTopic}"`);
    return false;
  }

  // 2. Verify Timestamp Freshness (Anti-Replay Attack)
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const timeDrift = Math.abs(currentTimestamp - ts);

  if (timeDrift > MAX_DRIFT_SECONDS) {
    console.warn(`[Verifier] Message rejected: Stale signature. Clock drift is ${timeDrift}s (limit: ${MAX_DRIFT_SECONDS}s)`);
    return false;
  }

  // 3. Verify Persistent Sequence (Anti-Replay for Control/Commands)
  const sequences = getSequences();
  const lastSeq = sequences[from.toLowerCase()] || 0;

  if (seq <= lastSeq) {
    console.warn(`[Verifier] Message rejected: Replayed sequence. Received: ${seq}, Last seen: ${lastSeq}`);
    return false;
  }

  // 4. Recover Signer Address from EIP-712 Typed Data
  try {
    const recoveredAddress = await recoverTypedDataAddress({
      domain: eip712Domain,
      types: eip712Types,
      primaryType: 'Telemetry',
      message: {
        from,
        topic,
        ts: BigInt(ts),
        seq: BigInt(seq),
        data,
      },
      signature,
    });

    // 5. Match Recovered Signer to Declared Sender Address
    const isValid = recoveredAddress.toLowerCase() === from.toLowerCase();
    if (!isValid) {
      console.warn(`[Verifier] Message rejected: Signature mismatch. Declared: ${from}, Recovered: ${recoveredAddress}`);
      return false;
    }

    // 6. Save valid sequence to persistent store
    saveSequence(from, seq);
    return true;
  } catch (error) {
    console.error('[Verifier] Failed to recover signature address:', error);
    return false;
  }
}
