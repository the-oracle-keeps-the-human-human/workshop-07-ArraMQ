import { verifyMessage } from "viem"
import mqtt from "mqtt"

const BROKER    = process.env.BROKER ?? "mqtt://localhost:1883"
const TTL_SEC   = 60  // reject messages older than 60s

type ArraMQMessage = {
  from: `0x${string}`
  ts:   number
  data: unknown
  sig:  `0x${string}`
}

async function verify(topic: string, msg: ArraMQMessage): Promise<boolean> {
  // freshness check
  if (Math.abs(Date.now() / 1000 - msg.ts) > TTL_SEC) {
    console.warn("Rejected: stale message", { ts: msg.ts })
    return false
  }

  // signature check
  const raw = `${msg.from}${msg.ts}${topic}${JSON.stringify(msg.data)}`
  const ok  = await verifyMessage({ address: msg.from, message: raw, signature: msg.sig })
  if (!ok) console.warn("Rejected: invalid signature", { from: msg.from })
  return ok
}

const client = mqtt.connect(BROKER, { clientId: "arra-sub-verifier" })

client.on("connect", () => {
  console.log("Subscriber connected, watching sensor/#")
  client.subscribe("sensor/#")
})

client.on("message", async (topic, buf) => {
  let msg: ArraMQMessage
  try { msg = JSON.parse(buf.toString()) }
  catch { console.error("Invalid JSON, dropped"); return }

  const ok = await verify(topic, msg)
  if (!ok) return

  console.log(`✅ Verified [${topic}] from ${msg.from}:`, msg.data)
})
