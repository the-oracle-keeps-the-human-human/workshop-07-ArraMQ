// ArraMQ PoC — message-level auth (Bun + viem)
// run: bun demo.ts   (self-contained: signs, verifies, shows tamper/replay/reroute fail)
// trust = signature ต่อ message · broker เป็นแค่ท่อ (vanilla, ไม่ต้องแก้)
//
// NOTE on signing (honest, per DustBoy fact-check PR #8):
//   ใช้ EIP-191 personal_sign + "string domain-prefix" (ARRA-MQTT/v1)
//   = app-level domain separation (string ต่างกันต่อแอป) — เบา เหมาะ ESP32
//   != EIP-712 typed-data domain (ไม่ได้ผูก chainId ใน digest ด้วย crypto)
//   ถ้าต้องการ chainId-binding จริง -> ใช้ signTypedData (EIP-712) แทน
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { keccak256, toHex, recoverMessageAddress } from 'viem'

const DOMAIN = 'ARRA-MQTT/v1'

// ---- DEVICE: sign a reading ----
async function signReading(account, topic, data) {
  const ts = Math.floor(Date.now() / 1000)
  const dataHash = keccak256(toHex(JSON.stringify(data)))
  const msg = `${DOMAIN}|data|${topic}|${ts}|${dataHash}`
  const sig = await account.signMessage({ message: msg }) // EIP-191 personal_sign
  return { addr: account.address, topic, data, ts, sig }
}

// ---- VERIFIER (the "verifying bridge") ----
// CRITICAL: ต้องรับ "delivery topic" (จาก MQTT) มาเทียบกับ topic ที่อยู่ใน signed body
// ไม่งั้น broker reroute ไป topic อื่นจะจับไม่ได้ (fix per DustBoy PR #8)
const lastTs: Record<string, number> = {} // addr -> last ts (monotonic = anti-replay)
async function verify(p, deliveryTopic, windowSec = 300) {
  if (deliveryTopic !== p.topic) return 'BAD_DELIVERY_TOPIC'              // broker-reroute: delivery != signed
  const dataHash = keccak256(toHex(JSON.stringify(p.data)))
  const msg = `${DOMAIN}|data|${p.topic}|${p.ts}|${dataHash}`
  const rec = await recoverMessageAddress({ message: msg, signature: p.sig })
  if (rec.toLowerCase() !== p.addr.toLowerCase()) return 'BAD_SIG'        // authenticity
  if (Math.abs(Date.now() / 1000 - p.ts) > windowSec) return 'STALE'      // freshness
  if (p.ts <= (lastTs[p.addr] || 0)) return 'REPLAY'                      // monotonic
  if (!p.topic.startsWith(`arra/${p.addr.toLowerCase()}/`)) return 'BAD_TOPIC' // ACL
  lastTs[p.addr] = p.ts
  return 'OK'
}

// ---- DEMO ----
const account = privateKeyToAccount(generatePrivateKey())
const topic = `arra/${account.address.toLowerCase()}/readings`

const good = await signReading(account, topic, { waterDepthMm: 142 })
console.log('valid    ->', await verify(good, topic))                 // OK

const tampered = { ...good, data: { waterDepthMm: 999 } }             // เปลี่ยนค่าหลังเซ็น
console.log('tampered ->', await verify(tampered, topic))            // BAD_SIG

console.log('reroute  ->', await verify(good, 'arra/evil/readings')) // BAD_DELIVERY_TOPIC (broker ส่งผิด topic)

console.log('replay   ->', await verify(good, topic))                // REPLAY (ts ไม่ monotonic)

// ---- MQTT wiring (ของจริงต่อ broker — vanilla Mosquitto/Aedes) ----
// import mqtt from 'mqtt'
// device:   client.publish(p.topic, JSON.stringify(p))
// verifier: client.subscribe('arra/+/readings')
//           client.on('message', async (deliveryTopic, m) => {       // <- delivery topic จาก MQTT จริง
//             const p = JSON.parse(m.toString())
//             const r = await verify(p, deliveryTopic)               // เทียบ delivery vs signed
//             if (r === 'OK') client.publish(`trusted/${p.topic}`, m) // republish to trusted broker (bridge)
//             else console.warn('drop', r)
//           })
