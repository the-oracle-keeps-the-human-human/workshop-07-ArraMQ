/**
 * ArraMQ publisher — signs an EIP-712 `Msg` and publishes to MQTT.
 *
 * Reads env:
 *   PRIVATE_KEY     hex (0x...)   — demo key only, never real funds
 *   NOVA_RPC_URL    URL           — Nova L2 RPC (block-hash source)
 *   MQTT_BROKER     URL           — e.g. mqtt://localhost:1883 or mqtts://host:8883
 *   ORZ_SEQ_FILE    path          — persisted seq file (default ./.orz-seq.json)
 *
 * Spec refs:
 *   EIP-712:  https://eips.ethereum.org/EIPS/eip-712
 *   EIP-191:  https://eips.ethereum.org/EIPS/eip-191
 *   viem:     https://viem.sh/docs/actions/wallet/signTypedData
 *
 * ---- Seq monotonicity design (cohort review fix 2026-06-20) ----------------
 *
 * Cross-restart monotonicity is a real problem: an in-memory counter (`let seq = 1n`)
 * resets to 1 on every restart, so verifier's (from, topic, seq) replay cache can
 * be defeated by simply restarting the publisher and re-emitting messages whose
 * old sigs are still within the blockHash freshness window.
 *
 * Hybrid clock+persisted scheme:
 *   1. clockSeq = Date.now() * 1000 + tick   (tick = per-process counter for same-ms collisions)
 *   2. persistedMax = read('./.orz-seq.json').lastSeq    (or 0 if absent)
 *   3. seq = max(clockSeq, persistedMax + 1n)            (guarantees monotonicity even under backward clock drift)
 *   4. after successful publish: write({lastSeq: seq.toString()}) back to file
 *
 * Why this works:
 *   - clock-derived term keeps seq ~strictly-increasing under normal operation, no file IO needed to grow
 *   - persisted floor protects against system clock going backward (NTP correction, VM time jump)
 *   - JSON file is stateless-friendly: works on any FS, no DB dependency, easy to inspect
 *
 * Honest limits (documented in PROPOSAL.md §7):
 *   - naive writeFileSync — crash mid-write could corrupt file (production should write-temp + rename)
 *   - file is per-process — multi-publisher-same-key needs distributed seq (out of scope, would need a shared store anyway)
 *
 * Reference: DustBoy cohort review msg 1517825121937526824, Jizo synth msg 1517825396718964846.
 * ----------------------------------------------------------------------------
 *
 * HONEST: this does NOT retry on broker disconnect — single-shot demo only.
 */

import { createWalletClient, createPublicClient, http, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import mqtt from "mqtt";

// ---- config ----------------------------------------------------------------

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;
const NOVA_RPC_URL = process.env.NOVA_RPC_URL ?? "https://rpc.nova.example";
const MQTT_BROKER = process.env.MQTT_BROKER ?? "mqtt://localhost:1883";
const SEQ_FILE = process.env.ORZ_SEQ_FILE ?? "./.orz-seq.json";

if (!PRIVATE_KEY) {
  console.error("PRIVATE_KEY env var required (demo key only — never real funds)");
  process.exit(1);
}

// EIP-712 domain — locked by fleet consensus 2026-06-20
const domain = {
  name: "ARRA-MQTT",
  version: "1",
  chainId: 20260619,
} as const;

const types = {
  Msg: [
    { name: "from",        type: "address" },
    { name: "topic",       type: "string"  },
    { name: "ts",          type: "uint64"  },
    { name: "blockHash",   type: "bytes32" },
    { name: "seq",         type: "uint64"  },
    { name: "payloadHash", type: "bytes32" },
  ],
} as const;

// ---- seq state -------------------------------------------------------------

let _tick = 0;

/** Read the last persisted seq from disk; returns 0n if absent / unreadable. */
function readPersistedSeq(path: string): bigint {
  if (!existsSync(path)) return 0n;
  try {
    const raw = readFileSync(path, "utf8");
    const obj = JSON.parse(raw) as { lastSeq?: string };
    if (!obj.lastSeq) return 0n;
    return BigInt(obj.lastSeq);
  } catch (err) {
    console.warn(`[publisher] WARN seq file unreadable, treating as 0: ${String(err)}`);
    return 0n;
  }
}

/** Persist the freshly-used seq back to disk. Sync write — PoC accepts the small atomicity gap. */
function writePersistedSeq(path: string, seq: bigint): void {
  writeFileSync(path, JSON.stringify({ lastSeq: seq.toString() }) + "\n", "utf8");
}

/** Compute next seq: max(clockDerived, persistedMax + 1). */
function nextSeq(path: string): bigint {
  const persistedMax = readPersistedSeq(path);
  const tick = BigInt(_tick++);
  const clockSeq = BigInt(Date.now()) * 1000n + tick;
  return clockSeq > persistedMax ? clockSeq : persistedMax + 1n;
}

// ---- main ------------------------------------------------------------------

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY!);
  const wallet = createWalletClient({ account, transport: http(NOVA_RPC_URL) });
  const pub = createPublicClient({ transport: http(NOVA_RPC_URL) });

  // Pull Nova head — this is the freshness oracle. See PROPOSAL.md §3.
  let blockHash: `0x${string}`;
  try {
    const block = await pub.getBlock({ blockTag: "latest" });
    blockHash = block.hash as `0x${string}`;
  } catch (err) {
    // HONEST: in offline demo the RPC may be unreachable; fall back to a placeholder.
    // Production verifier WILL reject this — that's the correct behavior.
    console.warn("[publisher] WARN cannot reach Nova RPC, using placeholder blockHash:", err);
    blockHash = ("0x" + "00".repeat(32)) as `0x${string}`;
  }

  const topic = `arra/${account.address.toLowerCase()}/telemetry`;
  const payload = JSON.stringify({
    hello: "from orz publisher",
    at: new Date().toISOString(),
  });
  const payloadHash = keccak256(toBytes(payload));
  const ts = BigInt(Math.floor(Date.now() / 1000));
  const seq = nextSeq(SEQ_FILE);

  const msg = {
    from: account.address,
    topic,
    ts,
    blockHash,
    seq,
    payloadHash,
  } as const;

  const sig = await wallet.signTypedData({
    account,
    domain,
    types,
    primaryType: "Msg",
    message: msg,
  });

  const envelope = {
    v: 1,
    msg: {
      from: msg.from,
      topic: msg.topic,
      ts: msg.ts.toString(),          // JSON-safe
      blockHash: msg.blockHash,
      seq: msg.seq.toString(),
      payloadHash: msg.payloadHash,
    },
    sig,
    payload,
  };

  // ---- publish -------------------------------------------------------------

  const client = mqtt.connect(MQTT_BROKER, {
    clientId: account.address.toLowerCase(),
    // HONEST: no TLS cert verification config here — demo only.
    rejectUnauthorized: false,
  });

  client.on("connect", () => {
    console.log("[publisher] connected to", MQTT_BROKER);
    client.publish(topic, JSON.stringify(envelope), { qos: 1 }, (err) => {
      if (err) {
        console.error("[publisher] publish error:", err);
        process.exit(1);
      }
      // Persist seq AFTER successful publish — if publish fails we don't burn the seq
      try {
        writePersistedSeq(SEQ_FILE, seq);
      } catch (writeErr) {
        // Non-fatal: next run will simply use clock-derived seq, still monotonic in practice
        console.warn("[publisher] WARN failed to persist seq:", writeErr);
      }
      console.log("[publisher] OK published", { topic, seq: seq.toString(), blockHash });
      client.end();
    });
  });

  client.on("error", (err) => {
    console.error("[publisher] mqtt error:", err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error("[publisher] fatal:", err);
  process.exit(1);
});
