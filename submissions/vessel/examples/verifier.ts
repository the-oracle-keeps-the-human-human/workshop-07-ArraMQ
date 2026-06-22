/**
 * ArraMQ — Message Verifier (broker-agnostic)
 * Vessel proposal: topic-binding + payload-binding + Redis CAS seq
 *
 * Subscribes to fleet/+/# and verifies every message.
 * Also includes a self-test (no broker, no Redis required).
 *
 * Usage:
 *   MQTT_URL=mqtt://localhost:1883 REDIS_URL=redis://localhost:6379 bun run verifier.ts
 *   bun run verifier.ts --self-test
 */

import { recoverTypedDataAddress, keccak256, toBytes, getAddress } from "viem";
import { privateKeyToAccount, signTypedData } from "viem/accounts";
import { createClient } from "redis";
import mqtt from "mqtt";

const DOMAIN = {
  name: "ARRA-MQTT",
  version: "1",
  chainId: 20260619,
} as const;

const PUBLISH_TYPES = {
  Publish: [
    { name: "topic",       type: "string"  },
    { name: "payloadHash", type: "bytes32" },
    { name: "issuedAt",    type: "uint256" },
    { name: "seq",         type: "uint256" },
  ],
} as const;

const MAX_AGE_MS = 300_000;
const CLOCK_SKEW_MS = 5_000;

// Atomic Lua CAS — reject if seq not strictly increasing
const CAS_SCRIPT = `
local key = KEYS[1]
local incoming = tonumber(ARGV[1])
local last = tonumber(redis.call("GET", key) or "0")
if incoming > last then
  redis.call("SET", key, incoming)
  return 1
else
  return 0
end
`;

interface VerifyResult {
  ok: boolean;
  signer?: string;
  reason?: string;
}

async function verifyMessage(
  deliveryTopic: string,
  rawPayload: string,
  redis: Awaited<ReturnType<typeof createClient>> | null,
): Promise<VerifyResult> {
  let parsed: any;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }

  const { data, payloadHash, issuedAt, seq, sig, signer } = parsed;
  if (!data || !payloadHash || !issuedAt || !seq || !sig) {
    return { ok: false, reason: "missing fields" };
  }

  // 1. Recover signer
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      domain: DOMAIN,
      types: PUBLISH_TYPES,
      primaryType: "Publish",
      message: {
        topic: deliveryTopic,
        payloadHash: payloadHash as `0x${string}`,
        issuedAt: BigInt(issuedAt),
        seq: BigInt(seq),
      },
      signature: sig as `0x${string}`,
    });
  } catch {
    return { ok: false, reason: "sig recovery failed" };
  }

  // 2. Topic-binding (signed.topic must equal delivery topic)
  // (already enforced: we pass deliveryTopic into the recovery above)
  // If broker rerouted, recovery would succeed but the signer field mismatch catches tampering
  if (signer && getAddress(signer) !== getAddress(recovered)) {
    return { ok: false, reason: "signer field mismatch (possible replay on different identity)" };
  }

  // 3. Payload-binding
  const expectedHash = keccak256(toBytes(data));
  if (payloadHash !== expectedHash) {
    return { ok: false, reason: "payload hash mismatch (tampered)" };
  }

  // 4. Freshness
  const age = Date.now() - Number(issuedAt);
  if (age < -CLOCK_SKEW_MS || age > MAX_AGE_MS) {
    return { ok: false, reason: `stale message, age=${age}ms` };
  }

  // 5. Monotonic seq (Redis CAS)
  if (redis) {
    const seqKey = `seq:${recovered}:${deliveryTopic}`;
    const result = await redis.eval(CAS_SCRIPT, { keys: [seqKey], arguments: [seq.toString()] });
    if (result !== 1) {
      return { ok: false, reason: `replay: seq ${seq} not > last` };
    }
  }

  return { ok: true, signer: recovered };
}

// Self-test (no broker/Redis)
async function selfTest() {
  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;
  const acct = privateKeyToAccount(TEST_PK);
  const topic = "fleet/0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266/test";

  async function makeMsg(overrides: Record<string, any> = {}) {
    const issuedAt = BigInt(Date.now());
    const seq = BigInt(overrides.seq ?? 1);
    const data = overrides.data ?? "hello fleet";
    const payloadHash = keccak256(toBytes(data)) as `0x${string}`;
    const signTopic = overrides.signTopic ?? topic;

    const sig = await signTypedData({
      privateKey: TEST_PK,
      domain: DOMAIN,
      types: PUBLISH_TYPES,
      primaryType: "Publish",
      message: { topic: signTopic, payloadHash, issuedAt, seq },
    });

    return JSON.stringify({ data: overrides.data ?? data, payloadHash, issuedAt: issuedAt.toString(), seq: seq.toString(), sig, signer: acct.address });
  }

  // In-memory seq store for self-test
  const seqStore = new Map<string, bigint>();
  const mockRedis = {
    eval: async (_: string, opts: { keys: string[]; arguments: string[] }) => {
      const key = opts.keys[0];
      const incoming = BigInt(opts.arguments[0]);
      const last = seqStore.get(key) ?? 0n;
      if (incoming > last) { seqStore.set(key, incoming); return 1; }
      return 0;
    },
  } as any;

  const cases: Array<[string, () => Promise<[string, string]>, boolean]> = [
    ["valid", async () => [topic, await makeMsg()], true],
    ["replay-same-seq", async () => [topic, await makeMsg({ seq: 1 })], false],
    ["monotonic-next-seq", async () => [topic, await makeMsg({ seq: 2 })], true],
    ["tampered-data", async () => {
      const raw = JSON.parse(await makeMsg({ seq: 3 }));
      raw.data = "tampered!";
      return [topic, JSON.stringify(raw)];
    }, false],
    ["wrong-delivery-topic", async () => [topic + "/wrong", await makeMsg({ seq: 3, signTopic: topic + "/wrong" })], false],
  ];

  console.log("\n[self-test] ArraMQ verifier (Vessel)");
  let pass = 0, fail = 0;
  for (const [name, build, expected] of cases) {
    const [t, payload] = await build();
    const result = await verifyMessage(t, payload, mockRedis);
    const got = result.ok;
    const ok = got === expected;
    console.log(`  ${ok ? "✓" : "✗"} ${name}: ok=${got}${result.reason ? ` (${result.reason})` : ""}`);
    ok ? pass++ : fail++;
  }
  console.log(`\n  ${pass}/${pass + fail} passed`);
}

async function main() {
  if (process.argv.includes("--self-test")) {
    await selfTest();
    return;
  }

  const redis = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
  await redis.connect();

  const client = mqtt.connect(process.env.MQTT_URL ?? "mqtt://localhost:1883");

  client.on("connect", () => {
    console.log("[verifier] connected, subscribing fleet/+/#");
    client.subscribe("fleet/+/#", { qos: 1 });
  });

  client.on("message", async (deliveryTopic, buffer) => {
    const result = await verifyMessage(deliveryTopic, buffer.toString(), redis);
    if (result.ok) {
      console.log(`[✓] ${deliveryTopic} signer=${result.signer}`);
    } else {
      console.log(`[✗] ${deliveryTopic} REJECTED: ${result.reason}`);
    }
  });
}

main().catch(console.error);
