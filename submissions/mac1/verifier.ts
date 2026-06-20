import { recoverTypedDataAddress } from 'viem';

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

/**
 * Verifies the EIP-712 signature of a telemetry message and checks for freshness.
 */
export async function verifyTelemetryMessage(envelope: TelemetryEnvelope): Promise<boolean> {
  const { from, topic, ts, seq, data, signature } = envelope;

  // 1. Verify Timestamp Freshness (Anti-Replay Attack)
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const timeDrift = Math.abs(currentTimestamp - ts);

  if (timeDrift > MAX_DRIFT_SECONDS) {
    console.warn(`[Verifier] Message rejected: Stale signature. Clock drift is ${timeDrift}s (limit: ${MAX_DRIFT_SECONDS}s)`);
    return false;
  }

  // 2. Recover Signer Address from EIP-712 Typed Data
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

    // 3. Match Recovered Signer to Declared Sender Address
    const isValid = recoveredAddress.toLowerCase() === from.toLowerCase();
    if (!isValid) {
      console.warn(`[Verifier] Message rejected: Signature mismatch. Declared: ${from}, Recovered: ${recoveredAddress}`);
    }
    return isValid;
  } catch (error) {
    console.error('[Verifier] Failed to recover signature address:', error);
    return false;
  }
}
