/**
 * ARRA-MQ core — sign / verify EIP-712 signed MQTT messages.
 *
 * trust อยู่ในข้อความ ไม่ใช่ที่ broker:
 *   publisher เซ็น EIP-712 typed-data → subscriber recover address แล้วเช็ค 5 gate
 *   broker เป็นแค่ท่อ (ปลอมข้อความไม่ได้เพราะไม่มีลายเซ็นที่ recover เป็น address ใน ACL)
 *
 * chain: ARRA Oracle L2 20260619 · workshop-07
 *
 * — Tinky Oracle ✨  [ubuntu-dev-one:tinky]  (AI, Rule 6)
 */
import {
  keccak256,
  stringToHex,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** EIP-712 domain — name+version+chainId กัน cross-domain/cross-chain replay */
export const DOMAIN = {
  name: "ARRA-MQTT",
  version: "1",
  chainId: 20260619,
} as const;

/** EIP-712 struct — เซ็น dataHash (ไม่ใช่ data ตรงๆ) → payload ใหญ่แค่ไหนลายเซ็นก็เท่าเดิม */
export const TYPES = {
  Message: [
    { name: "from", type: "address" },
    { name: "topic", type: "string" },
    { name: "ts", type: "uint64" },
    { name: "seq", type: "uint64" },
    { name: "nonce", type: "bytes32" },
    { name: "dataHash", type: "bytes32" },
  ],
} as const;

const ZERO_NONCE =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

/** envelope ที่ส่งผ่าน MQTT จริง (data อยู่ในนี้ตรงๆ, verifier คำนวณ dataHash เอง) */
export interface Envelope {
  from: Address;
  topic: string;
  ts: number; // unix seconds
  seq: string; // uint64 as string (กัน JS number overflow)
  nonce: Hex; // bytes32; ZERO_NONCE สำหรับ telemetry/event
  data: unknown;
  sig: Hex;
}

/** keccak256 ของ payload (canonical JSON) — ต้องคำนวณเหมือนกันทั้ง sign + verify */
export function hashData(data: unknown): Hex {
  return keccak256(stringToHex(JSON.stringify(data)));
}

/** publisher: เซ็น 1 ข้อความ → คืน envelope พร้อมส่ง */
export async function signMessage(args: {
  privateKey: Hex;
  topic: string;
  data: unknown;
  seq: bigint;
  ts?: number;
  nonce?: Hex; // ใส่ server-epoch nonce เฉพาะ command
}): Promise<Envelope> {
  const account = privateKeyToAccount(args.privateKey);
  const ts = args.ts ?? Math.floor(Date.now() / 1000);
  const nonce = args.nonce ?? ZERO_NONCE;
  const dataHash = hashData(args.data);

  const sig = await account.signTypedData({
    domain: DOMAIN,
    types: TYPES,
    primaryType: "Message",
    message: {
      from: account.address,
      topic: args.topic,
      ts: BigInt(ts),
      seq: args.seq,
      nonce,
      dataHash,
    },
  });

  return {
    from: account.address,
    topic: args.topic,
    ts,
    seq: args.seq.toString(),
    nonce,
    data: args.data,
    sig,
  };
}

export type VerifyResult =
  | { ok: true; from: Address }
  | { ok: false; gate: string; reason: string };

export interface VerifierPolicy {
  /** address ที่อนุญาต (lowercased). undefined = อนุญาตทุกคน (ไม่แนะนำใน prod) */
  acl?: Set<string>;
  /** address ที่ถูกถอนสิทธิ (lowercased) — gate ที่ 5 ⭐ */
  revoked?: Set<string>;
  /** เพดาน clock skew (วินาที) สำหรับ freshness gate */
  windowSec?: number;
  /** topic ที่ MQTT ส่งมาจริง (กัน reroute) — ถ้าไม่ใส่จะข้าม topic gate */
  actualTopic?: string;
  /** seq ล่าสุดที่เคยเห็นต่อ address (state, mutate ใน place เมื่อ accept) */
  lastSeq: Map<string, bigint>;
}

/**
 * verifier: เช็ค 5 gate ตามลำดับ — พลาด gate ไหน DENY ทันที
 *   1. recover(sig) == from              (authenticity + integrity, ครอบ tamper เพราะ dataHash)
 *   2. topic ใน payload == topic จริง    (กัน reroute/topic-spoof)
 *   3. |now - ts| <= windowSec            (freshness)
 *   4. seq > lastSeq[from]                (anti-replay, monotonic)
 *   5. from ∈ acl  ∧  from ∉ revoked      (authorization + revocation ⭐)
 *
 * mutate lastSeq เฉพาะตอน ACCEPT เท่านั้น
 */
export async function verifyMessage(
  env: Envelope,
  policy: VerifierPolicy,
  now: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  const windowSec = policy.windowSec ?? 30;
  const fromLc = env.from.toLowerCase();

  // gate 1 — recover. dataHash คำนวณใหม่จาก data ที่รับ → tamper data = recover เพี้ยน = ไม่ตรง from
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: DOMAIN,
      types: TYPES,
      primaryType: "Message",
      message: {
        from: env.from,
        topic: env.topic,
        ts: BigInt(env.ts),
        seq: BigInt(env.seq),
        nonce: env.nonce,
        dataHash: hashData(env.data),
      },
      signature: env.sig,
    });
  } catch (e) {
    return { ok: false, gate: "recover", reason: `bad signature: ${String(e)}` };
  }
  if (recovered.toLowerCase() !== fromLc) {
    return {
      ok: false,
      gate: "recover",
      reason: `recovered ${recovered} != from ${env.from} (tampered or forged)`,
    };
  }

  // gate 2 — topic binding
  if (policy.actualTopic !== undefined && policy.actualTopic !== env.topic) {
    return {
      ok: false,
      gate: "topic",
      reason: `signed topic '${env.topic}' != delivered topic '${policy.actualTopic}'`,
    };
  }

  // gate 3 — freshness
  if (Math.abs(now - env.ts) > windowSec) {
    return {
      ok: false,
      gate: "freshness",
      reason: `ts skew ${now - env.ts}s exceeds window ${windowSec}s (stale/replay)`,
    };
  }

  // gate 4 — monotonic seq (anti-replay)
  const seq = BigInt(env.seq);
  const last = policy.lastSeq.get(fromLc);
  if (last !== undefined && seq <= last) {
    return {
      ok: false,
      gate: "seq",
      reason: `seq ${seq} <= lastSeq ${last} (replay)`,
    };
  }

  // gate 5 — authorization + revocation ⭐
  if (policy.acl && !policy.acl.has(fromLc)) {
    return { ok: false, gate: "acl", reason: `${env.from} not in ACL` };
  }
  if (policy.revoked && policy.revoked.has(fromLc)) {
    return {
      ok: false,
      gate: "revocation",
      reason: `${env.from} key revoked (compromise containment)`,
    };
  }

  // ผ่านครบ → commit seq
  policy.lastSeq.set(fromLc, seq);
  return { ok: true, from: env.from };
}
