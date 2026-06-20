// ArraMQ PoC — subscriber/verifier (E2E): verify sig + integrity + freshness + replay
// broker เป็น relay เปล่า — trust ทั้งหมดอยู่ที่นี่ (verify ที่ปลายทาง)
// run:  BROKER=mqtt://localhost:1883 bun subscriber.ts
import mqtt from "mqtt"
import { verifyTypedData, keccak256, toHex } from "viem"

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
const last = new Map<string, number>() // from -> lastSeq (mesh-safe ที่ subscriber)

const sub = mqtt.connect(process.env.BROKER ?? "mqtt://localhost:1883")
sub.on("connect", () => sub.subscribe("sensors/#"))
sub.on("message", async (_topic, buf) => {
  let e: any
  try { e = JSON.parse(buf.toString()) } catch { return }

  // 1) integrity: dataHash ต้องตรงกับ data ที่ส่งมา
  const dataHash = keccak256(toHex(e.data))
  const message = { from: e.from, topic: e.topic, ts: BigInt(e.ts), seq: BigInt(e.seq), dataHash }

  // 2) authenticity: ลายเซ็น EIP-712 ต้อง recover ได้ == from
  const ok = await verifyTypedData({ address: e.from, domain, types, primaryType: "Msg", message, signature: e.sig })
  if (!ok)                                        return console.warn("drop: bad sig")
  // 3) freshness: ใหม่พอ (กัน sig เก่า)
  if (Math.floor(Date.now() / 1000) - e.ts > WINDOW) return console.warn("drop: stale")
  // 4) replay: seq ต้องเดินหน้า
  if (e.seq <= (last.get(e.from) ?? -1))          return console.warn("drop: replay")

  last.set(e.from, e.seq)
  console.log("OK", e.from, e.topic, "seq", e.seq, JSON.parse(e.data))
})
console.log("verifier up — broker = vanilla relay, trust = E2E signatures")
