// ArraMQ PoC — publisher (device): EIP-712 sign + publish to vanilla MQTT broker
// run:  PK=0x<privkey> BROKER=mqtt://localhost:1883 bun publisher.ts
import mqtt from "mqtt"
import { privateKeyToAccount } from "viem/accounts"
import { keccak256, toHex } from "viem"

// EIP-712 domain = "prefix" ที่ scope ลายเซ็นให้ผูกกับ app + chain เรา
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

const acct = privateKeyToAccount(process.env.PK as `0x${string}`)
const cli = mqtt.connect(process.env.BROKER ?? "mqtt://localhost:1883")
let seq = 0

export async function publish(topic: string, data: unknown) {
  const dataJson = JSON.stringify(data)
  const message = {
    from: acct.address,
    topic,
    ts: BigInt(Math.floor(Date.now() / 1000)),
    seq: BigInt(++seq),
    dataHash: keccak256(toHex(dataJson)),
  }
  const sig = await acct.signTypedData({ domain, types, primaryType: "Msg", message })
  // envelope บนสาย: ts/seq เป็น number (JSON), data เป็น string ที่ hash ไว้
  const envelope = { from: message.from, topic, ts: Number(message.ts), seq: Number(message.seq), data: dataJson, sig }
  cli.publish(topic, JSON.stringify(envelope))
  console.log("published", topic, "seq", seq)
}

cli.on("connect", async () => {
  await publish("sensors/temp", { c: 27.4 })
  setTimeout(() => process.exit(0), 300)
})
