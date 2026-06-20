// Per-message E2E verification — the "topic-in-signed-body + real EIP-712 + persisted seq" triad.
// Identity, topic, freshness and ordering all live INSIDE the signed typed-data. B3 Oracle 🦁
import { verifyTypedData, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { bumpSeq, seenOnce } from "./store.js";

const CHAIN_ID  = Number(process.env.CHAIN_ID || 20260619);
const MAX_AGE_S = 300;

const domain = { name: "ArraMQ", version: "1", chainId: CHAIN_ID };
const types  = { Msg: [
  { name: "from",     type: "address" },
  { name: "topic",    type: "string"  },   // topic is SIGNED → broker can't reroute undetected
  { name: "ts",       type: "uint64"  },
  { name: "seq",      type: "uint64"  },
  { name: "dataHash", type: "bytes32" },    // keccak256 of the payload string
]};

// envelope = { from, topic, ts, seq, data, sig } ; deliveryTopic = the MQTT topic it actually arrived on
export async function verifyMessage(envelope, deliveryTopic) {
  const { from, topic, ts, seq, data, sig } = envelope;

  // 1) topic-binding: what was signed must equal where it was delivered (blocks broker reroute)
  if (topic !== deliveryTopic) return { ok: false, reason: "TOPIC_MISMATCH" };

  // 2) signer↔topic authorization: a wallet may only publish under arra/<its-address>/...
  if (!topic.toLowerCase().startsWith(`arra/${getAddress(from).toLowerCase()}/`))
    return { ok: false, reason: "TOPIC_NOT_OWNED" };

  // 3) real EIP-712 typed-data recovery (chainId + domain bound into the digest)
  const value = { from: getAddress(from), topic, ts, seq, dataHash: keccak256(toUtf8Bytes(data)) };
  let recovered;
  try { recovered = verifyTypedData(domain, types, value, sig); }
  catch { return { ok: false, reason: "BAD_SIG" }; }
  if (getAddress(recovered) !== getAddress(from)) return { ok: false, reason: "ADDR_MISMATCH" };

  // 4) freshness window
  const ageS = Math.floor(Date.now() / 1000) - Number(ts);
  if (ageS < -30 || ageS > MAX_AGE_S) return { ok: false, reason: `STALE(${ageS}s)` };

  // 5) persisted anti-replay: monotonic per-sender seq (atomic in Redis → mesh-safe)
  if (!(await bumpSeq(getAddress(from), Number(seq)))) return { ok: false, reason: "REPLAY_SEQ" };
  // belt-and-suspenders: single-use signature within the window
  if (!(await seenOnce(sig, MAX_AGE_S))) return { ok: false, reason: "REPLAY_SIG" };

  return { ok: true, from: getAddress(from), topic, seq: Number(seq) };
}
