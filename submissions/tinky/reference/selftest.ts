/**
 * ARRA-MQ honest self-test — รันได้ทันที ไม่ต้องมี broker/network.
 *
 *   cd reference && bun install && bun selftest.ts
 *
 * พิสูจน์ว่า verifier ทั้ง 5 gate ทำงานจริง — เคส DENY ต้อง DENY จริง
 * ไม่งั้น exit != 0. honest gate (Rule 6: ไม่อวด happy path อย่างเดียว).
 *
 * — Tinky Oracle ✨  [ubuntu-dev-one:tinky]  (AI, Rule 6)
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  signMessage,
  verifyMessage,
  type Envelope,
  type VerifierPolicy,
} from "./arramq";

// ── สอง device: dev = ใน ACL, intruder = ไม่อยู่ใน ACL ──
const devKey = generatePrivateKey();
const dev = privateKeyToAccount(devKey);
const intruderKey = generatePrivateKey();
const intruder = privateKeyToAccount(intruderKey);

const NOW = 1_750_000_000; // unix ts คงที่ → deterministic test
const TOPIC = "sensors/room-1/temp";

function freshPolicy(): VerifierPolicy {
  return {
    acl: new Set([dev.address.toLowerCase()]),
    revoked: new Set<string>(),
    windowSec: 30,
    actualTopic: TOPIC,
    lastSeq: new Map(),
  };
}

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail: string) {
  if (cond) {
    pass++;
    console.log(`✅ PASS  ${name}  — ${detail}`);
  } else {
    fail++;
    console.log(`❌ FAIL  ${name}  — ${detail}`);
  }
}

async function main() {
  console.log("─── ARRA-MQ self-test (zero broker) ───\n");

  // 1) happy path — เซ็นถูก สดใหม่ → ACCEPT
  {
    const p = freshPolicy();
    const env = await signMessage({
      privateKey: devKey,
      topic: TOPIC,
      data: { tempC: 24.5 },
      seq: 1n,
      ts: NOW,
    });
    const r = await verifyMessage(env, p, NOW);
    check("1 happy-path", r.ok, r.ok ? "accepted" : `unexpected DENY @${r.gate}: ${r.reason}`);
  }

  // 2) tamper data หลังเซ็น → DENY @recover (dataHash เพี้ยน)
  {
    const p = freshPolicy();
    const env = await signMessage({
      privateKey: devKey,
      topic: TOPIC,
      data: { tempC: 24.5 },
      seq: 1n,
      ts: NOW,
    });
    const tampered: Envelope = { ...env, data: { tempC: 99.9 } }; // แอบแก้ค่า
    const r = await verifyMessage(tampered, p, NOW);
    check(
      "2 tamper-data",
      !r.ok && r.gate === "recover",
      r.ok ? "WRONGLY accepted tampered data" : `denied @${r.gate}`,
    );
  }

  // 3) replay (seq ซ้ำ/ต่ำกว่าเดิม) → DENY @seq
  {
    const p = freshPolicy();
    const e1 = await signMessage({ privateKey: devKey, topic: TOPIC, data: { tempC: 24 }, seq: 5n, ts: NOW });
    await verifyMessage(e1, p, NOW); // commit seq=5
    const replay = await signMessage({ privateKey: devKey, topic: TOPIC, data: { tempC: 24 }, seq: 5n, ts: NOW });
    const r = await verifyMessage(replay, p, NOW);
    check(
      "3 replay-seq",
      !r.ok && r.gate === "seq",
      r.ok ? "WRONGLY accepted replay" : `denied @${r.gate}`,
    );
  }

  // 4) ส่งผิด topic (reroute) → DENY @topic
  {
    const p = freshPolicy();
    const env = await signMessage({
      privateKey: devKey,
      topic: "sensors/room-1/humidity", // เซ็น topic อื่น
      data: { rh: 60 },
      seq: 1n,
      ts: NOW,
    });
    // broker delivery topic = TOPIC แต่ลายเซ็นบอก humidity
    const r = await verifyMessage(env, p, NOW);
    check(
      "4 topic-reroute",
      !r.ok && r.gate === "topic",
      r.ok ? "WRONGLY accepted rerouted msg" : `denied @${r.gate}`,
    );
  }

  // 5) ข้อความเก่า (ts เกิน window) → DENY @freshness
  {
    const p = freshPolicy();
    const env = await signMessage({
      privateKey: devKey,
      topic: TOPIC,
      data: { tempC: 24 },
      seq: 1n,
      ts: NOW - 120, // เก่า 2 นาที, window 30s
    });
    const r = await verifyMessage(env, p, NOW);
    check(
      "5 stale-ts",
      !r.ok && r.gate === "freshness",
      r.ok ? "WRONGLY accepted stale msg" : `denied @${r.gate}`,
    );
  }

  // 6) address ไม่อยู่ใน ACL → DENY @acl
  {
    const p = freshPolicy();
    const env = await signMessage({
      privateKey: intruderKey, // เซ็นถูก แต่ไม่ใช่คนที่ได้รับอนุญาต
      topic: TOPIC,
      data: { tempC: 24 },
      seq: 1n,
      ts: NOW,
    });
    const r = await verifyMessage(env, p, NOW);
    check(
      "6 not-in-acl",
      !r.ok && r.gate === "acl",
      r.ok ? "WRONGLY accepted unauthorized signer" : `denied @${r.gate}`,
    );
  }

  // 7) ⭐ คีย์ถูก revoke (เซ็นถูก, อยู่ใน ACL เดิม แต่ถูกถอน) → DENY @revocation
  {
    const p = freshPolicy();
    p.revoked.add(dev.address.toLowerCase()); // คีย์ dev รั่ว → ถอนสิทธิ
    const env = await signMessage({
      privateKey: devKey, // คีย์จริง ลายเซ็น valid ทุกอย่าง
      topic: TOPIC,
      data: { tempC: 24 },
      seq: 1n,
      ts: NOW,
    });
    const r = await verifyMessage(env, p, NOW);
    check(
      "7 revoked-key ⭐",
      !r.ok && r.gate === "revocation",
      r.ok ? "WRONGLY accepted revoked key (compromise!)" : `denied @${r.gate}`,
    );
  }

  console.log(`\n─── result: ${pass} passed, ${fail} failed ───`);
  if (fail > 0) {
    console.log("⛔ self-test FAILED — verifier ไม่ปลอดภัย");
    process.exit(1);
  }
  console.log("✅ all gates honest — accept สิ่งที่ควร accept, deny สิ่งที่ควร deny");
}

main().catch((e) => {
  console.error("self-test crashed:", e);
  process.exit(1);
});
