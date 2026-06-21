/**
 * ARRA-MQ subscriber/verifier — รับข้อความ แล้ว verify E2E ครบ 5 gate.
 *
 *   bun subscriber.ts           # รอ verify (ปล่อยค้างไว้)
 *   bun publisher.ts            # อีก terminal ส่งข้อความ
 *
 * ACL_ADDRESS (env) — address ที่อนุญาต (default = hardhat #0)
 * REVOKED (env)     — comma-separated addresses ที่ถูกถอน (ทดสอบ revocation)
 *
 * — Tinky Oracle ✨  [ubuntu-dev-one:tinky]  (AI, Rule 6)
 */
import mqtt from "mqtt";
import { verifyMessage, type Envelope, type VerifierPolicy } from "./arramq";

const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const TOPIC = process.env.TOPIC ?? "sensors/room-1/temp";
const ACL_ADDRESS = (
  process.env.ACL_ADDRESS ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
).toLowerCase(); // hardhat #0 address

const acl = new Set(ACL_ADDRESS.split(",").map((a) => a.trim().toLowerCase()));
const revoked = new Set(
  (process.env.REVOKED ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean),
);

// state ต่อ subscriber: lastSeq ต่อ address (mesh-safe ที่ verify เดียวต่อ subscriber)
const policy: VerifierPolicy = {
  acl,
  revoked,
  windowSec: 30,
  lastSeq: new Map(),
};

console.log(`[sub] ${MQTT_URL}  topic ${TOPIC}`);
console.log(`[sub] ACL=[${[...acl].join(",")}]  revoked=[${[...revoked].join(",")}]`);

const client = mqtt.connect(MQTT_URL);

client.on("connect", () => {
  client.subscribe(TOPIC, { qos: 1 }, (err) => {
    if (err) {
      console.error("[sub] subscribe failed:", err.message);
      process.exit(1);
    }
    console.log("[sub] subscribed, waiting for signed messages…");
  });
});

client.on("message", async (deliveredTopic, payload) => {
  let env: Envelope;
  try {
    env = JSON.parse(payload.toString());
  } catch {
    console.log("⛔ DENY  malformed envelope (not JSON)");
    return;
  }
  // ใช้ topic ที่ broker ส่งมาจริง เป็น actualTopic (gate 2 กัน reroute)
  const r = await verifyMessage(env, { ...policy, actualTopic: deliveredTopic });
  if (r.ok) {
    console.log(`✅ ACCEPT  from ${env.from.slice(0, 10)}… seq=${env.seq} data=${JSON.stringify(env.data)}`);
  } else {
    console.log(`⛔ DENY    @${r.gate}: ${r.reason}`);
  }
});

client.on("error", (e) => {
  console.error("[sub] mqtt error:", e.message);
  process.exit(1);
});
