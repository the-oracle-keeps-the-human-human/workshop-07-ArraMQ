/**
 * ArraMQ verifier — subscribes to `arra/+/+`, verifies every PUBLISH:
 *   0) delivery topic === envelope.msg.topic  ← topic-binding (anti-reroute)
 *   1) recoverTypedDataAddress(sig) === envelope.msg.from
 *   2) blockHash freshness — must match a Nova block within last N blocks (default 100)
 *   3) ts within ±60s of wall clock
 *   4) keccak256(payload) === envelope.msg.payloadHash
 *   5) (from, topic, seq) not already seen in window  ← replay defense
 *
 * Spec refs:
 *   EIP-712:  https://eips.ethereum.org/EIPS/eip-712
 *   viem recoverTypedDataAddress: https://viem.sh/docs/utilities/recoverTypedDataAddress
 *
 * HONEST: in-memory seen-cache grows O(active_pubs × window_s × pub_rate). Sized for demo,
 * not fleet-scale. Bounded by `MAX_SEEN_ENTRIES` (FIFO eviction). See PROPOSAL.md §7.7.
 *
 * HONEST: blockHash check uses `getBlock({blockHash})` — one RPC per message. Production
 * should cache recent block hashes locally. Not implemented in this PoC.
 */

import { createPublicClient, http, keccak256, toBytes, recoverTypedDataAddress } from "viem";
import mqtt from "mqtt";

// ---- config ----------------------------------------------------------------

const NOVA_RPC_URL = process.env.NOVA_RPC_URL ?? "https://rpc.nova.example";
const MQTT_BROKER = process.env.MQTT_BROKER ?? "mqtt://localhost:1883";
const FRESHNESS_BLOCKS = Number(process.env.FRESHNESS_BLOCKS ?? 100); // ~200s on Nova
const TS_WINDOW_SEC = Number(process.env.TS_WINDOW_SEC ?? 60);
const MAX_SEEN_ENTRIES = 10_000;

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

// ---- state -----------------------------------------------------------------

const seen = new Map<string, number>(); // key = `${from}|${topic}|${seq}` → insertion ts
const pub = createPublicClient({ transport: http(NOVA_RPC_URL) });

function recordSeen(key: string) {
  if (seen.size >= MAX_SEEN_ENTRIES) {
    // FIFO evict oldest 10% in one shot
    const evictN = Math.floor(MAX_SEEN_ENTRIES / 10);
    let i = 0;
    for (const k of seen.keys()) {
      seen.delete(k);
      if (++i >= evictN) break;
    }
  }
  seen.set(key, Date.now());
}

// ---- verify ----------------------------------------------------------------

type Envelope = {
  v: number;
  msg: {
    from: `0x${string}`;
    topic: string;
    ts: string;
    blockHash: `0x${string}`;
    seq: string;
    payloadHash: `0x${string}`;
  };
  sig: `0x${string}`;
  payload: string;
};

async function verify(
  env: Envelope,
  deliveryTopic: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { msg, sig, payload } = env;

  // (0) topic binding — defense against broker reroute attack
  //     Without this, a malicious broker could deliver a sig valid for
  //     arra/0xAlice/telemetry to subscribers of arra/0xBob/cmd, since
  //     msg.topic is what the publisher signed, NOT what was delivered.
  //     Caught by DustBoy/Jizo cohort review 2026-06-20.
  if (deliveryTopic !== msg.topic) {
    return {
      ok: false,
      reason: `topic mismatch: delivery=${deliveryTopic} signed=${msg.topic}`,
    };
  }

  // (4) payload binding
  const recomputedHash = keccak256(toBytes(payload));
  if (recomputedHash.toLowerCase() !== msg.payloadHash.toLowerCase()) {
    return { ok: false, reason: "payloadHash mismatch" };
  }

  // (1) sig recovery
  let recovered: `0x${string}`;
  try {
    recovered = await recoverTypedDataAddress({
      domain,
      types,
      primaryType: "Msg",
      message: {
        from: msg.from,
        topic: msg.topic,
        ts: BigInt(msg.ts),
        blockHash: msg.blockHash,
        seq: BigInt(msg.seq),
        payloadHash: msg.payloadHash,
      },
      signature: sig,
    });
  } catch (err) {
    return { ok: false, reason: `sig recover failed: ${String(err)}` };
  }
  if (recovered.toLowerCase() !== msg.from.toLowerCase()) {
    return { ok: false, reason: `from mismatch: claimed=${msg.from} recovered=${recovered}` };
  }

  // (3) ts window
  const nowSec = Math.floor(Date.now() / 1000);
  const age = nowSec - Number(msg.ts);
  if (Math.abs(age) > TS_WINDOW_SEC) {
    return { ok: false, reason: `ts out of window (age=${age}s, max=${TS_WINDOW_SEC}s)` };
  }

  // (2) blockHash freshness
  try {
    const block = await pub.getBlock({ blockHash: msg.blockHash });
    const head = await pub.getBlock({ blockTag: "latest" });
    const blockAge = Number(head.number - block.number);
    if (blockAge < 0 || blockAge > FRESHNESS_BLOCKS) {
      return { ok: false, reason: `stale blockHash (age=${blockAge} blocks, max=${FRESHNESS_BLOCKS})` };
    }
  } catch (err) {
    return { ok: false, reason: `unknown blockHash: ${String(err)}` };
  }

  // (5) replay
  const key = `${msg.from.toLowerCase()}|${msg.topic}|${msg.seq}`;
  if (seen.has(key)) {
    return { ok: false, reason: `replay (seq=${msg.seq} already seen)` };
  }
  recordSeen(key);

  return { ok: true };
}

// ---- mqtt loop -------------------------------------------------------------

const client = mqtt.connect(MQTT_BROKER, {
  clientId: `verifier-${Math.random().toString(16).slice(2, 8)}`,
  rejectUnauthorized: false,
});

client.on("connect", () => {
  console.log("[verifier] connected, subscribing arra/+/+");
  client.subscribe("arra/+/+", { qos: 1 });
});

client.on("message", async (topic, buf) => {
  const startedAt = Date.now();
  let env: Envelope;
  try {
    env = JSON.parse(buf.toString()) as Envelope;
  } catch {
    console.log(`[verifier] REJECT bad-json topic=${topic}`);
    return;
  }

  const result = await verify(env, topic);
  const ms = Date.now() - startedAt;
  if (result.ok) {
    console.log(`[verifier] OK   from=${env.msg.from} topic=${topic} seq=${env.msg.seq} age=${ms}ms`);
  } else {
    console.log(`[verifier] REJECT ${result.reason}  topic=${topic} from=${env.msg.from}`);
  }
});

client.on("error", (err) => console.error("[verifier] mqtt error:", err));
