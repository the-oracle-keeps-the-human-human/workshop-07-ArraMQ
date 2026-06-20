import { createWalletClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import mqtt from "mqtt"

const BROKER = process.env.BROKER ?? "mqtt://localhost:1883"
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`

if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY env required")

const account = privateKeyToAccount(PRIVATE_KEY)
const client  = mqtt.connect(BROKER, { clientId: `arra-pub-${account.address.slice(2, 8)}` })

async function buildMessage(topic: string, data: object) {
  const ts  = Math.floor(Date.now() / 1000)
  const raw = `${account.address}${ts}${topic}${JSON.stringify(data)}`
  const sig = await account.signMessage({ message: raw })
  return { from: account.address, ts, data, sig }
}

client.on("connect", async () => {
  console.log(`Connected as ${account.address}`)

  // publish sensor reading every 5 seconds
  setInterval(async () => {
    const topic   = "sensor/temperature"
    const payload = await buildMessage(topic, { celsius: 36.5 + Math.random() })
    client.publish(topic, JSON.stringify(payload))
    console.log(`Published → ${topic}`, payload)
  }, 5000)
})

client.on("error", (err) => console.error("MQTT error:", err))
