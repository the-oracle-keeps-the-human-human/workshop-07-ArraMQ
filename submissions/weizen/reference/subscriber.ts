// ArraMQ PoC — subscriber/verifier (E2E): verify sig + integrity + freshness + replay
// broker เป็น relay เปล่า — trust ทั้งหมดอยู่ที่นี่ (verify ที่ปลายทาง)
// run:  BROKER=mqtt://localhost:1883 bun subscriber.ts
//
// ครบ "3 จุดแข็ง" ที่ cohort ชี้ (DustBoy/Jizo finding 2026-06-20):
//   (1) topic-in-signed-body + enforce delivery==signed  (กัน broker reroute)
//   (2) EIP-712 จริง (signTypedData/verifyTypedData, domain เข้า digest — ไม่ใช่ป้าย)
//   (3) persisted seq (file-backed) — restart/scale แล้ว replay protection ไม่หาย
import mqtt from "mqtt"
import { verifyTypedData, keccak256, toHex } from "viem"
import { readFileSync, writeFileSync, existsSync } from "node:fs"

const domain = { name: "ARRA-MQTT", version: "1", chainId: 20260619 } as const
const types = {
  Msg: [
    { name: "from", type: "address" },
    { name: "topic", type: "string" },
    { name: "ts", type: "uint64" },
    { name: "seq", type: "uint64" },
    { name: "dataHash", type: "bytes32" },
  ],
} as const

const WINDOW = 300 // วินาที — freshness (time-based)

// (3) persisted seq store — file-backed (PoC). production: Redis/KV/DB
//     restart แล้ว lastSeq ไม่หาย -> replay protection คงอยู่
const SEQ_FILE = process.env.SEQ_FILE ?? "./seq-store.json"
const last: Record<string, number> = existsSync(SEQ_FILE) ? JSON.parse(readFileSync(SEQ_FILE, "utf8")) : {}
const setSeq = (from: string, seq: number) => { last[from] = seq; writeFileSync(SEQ_FILE, JSON.stringify(last)) }

const sub = mqtt.connect(process.env.BROKER ?? "mqtt://localhost:1883")
sub.on("connect", () => sub.subscribe("sensors/#"))
sub.on("message", async (deliveryTopic, buf) => {
  let e: any
  try { e = JSON.parse(buf.toString()) } catch { return }

  // (1) topic-binding: topic ที่เซ็น ต้อง == topic ที่ broker ส่งมาจริง
  //     กัน broker reroute message ข้าม topic (sig valid แต่ผิดปลายทาง)
  if (e.topic !== deliveryTopic)                  return console.warn("drop: topic mismatch (reroute)")

  // integrity: dataHash ต้องตรงกับ data ที่ส่งมา
  const dataHash = keccak256(toHex(e.data))
  const message = { from: e.from, topic: e.topic, ts: BigInt(e.ts), seq: BigInt(e.seq), dataHash }

  // (2) authenticity: EIP-712 verify — recover == from (domain ARRA-MQTT/chain เข้า digest)
  const ok = await verifyTypedData({ address: e.from, domain, types, primaryType: "Msg", message, signature: e.sig })
  if (!ok)                                        return console.warn("drop: bad sig")
  // freshness: ใหม่พอ (กัน sig เก่า)
  if (Math.floor(Date.now() / 1000) - e.ts > WINDOW) return console.warn("drop: stale")
  // (3) replay: seq ต้องเดินหน้า (เทียบกับ persisted store)
  if (e.seq <= (last[e.from] ?? -1))              return console.warn("drop: replay")

  setSeq(e.from, e.seq)
  console.log("OK", e.from, e.topic, "seq", e.seq, JSON.parse(e.data))
})
console.log("verifier up — broker = vanilla relay, trust = E2E signatures (topic-bound + EIP-712 + persisted seq)")
