// SIWE-MQTT PoC — message-level auth (Bun + viem)
// run: bun demo.ts   (self-contained: signs, verifies, shows tamper/replay fail)
// trust = signature ต่อ message · broker เป็นแค่ท่อ (vanilla, ไม่ต้องแก้)
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { keccak256, toHex, recoverMessageAddress } from 'viem'

const DOMAIN = 'floodboy/v1'

// ---- DEVICE: sign a reading ----
async function signReading(account, topic, data) {
  const ts = Math.floor(Date.now() / 1000)
  const dataHash = keccak256(toHex(JSON.stringify(data)))
  const msg = `${DOMAIN}|data|${topic}|${ts}|${dataHash}`
  const sig = await account.signMessage({ message: msg }) // EIP-191 personal_sign
  return { addr: account.address, topic, data, ts, sig }
}

// ---- VERIFIER (the "verifying bridge") ----
const lastTs: Record<string, number> = {} // addr -> last ts (monotonic = anti-replay)
async function verify(p, windowSec = 300) {
  const dataHash = keccak256(toHex(JSON.stringify(p.data)))
  const msg = `${DOMAIN}|data|${p.topic}|${p.ts}|${dataHash}`
  const rec = await recoverMessageAddress({ message: msg, signature: p.sig })
  if (rec.toLowerCase() !== p.addr.toLowerCase()) return 'BAD_SIG'        // authenticity
  if (Math.abs(Date.now() / 1000 - p.ts) > windowSec) return 'STALE'      // freshness
  if (p.ts <= (lastTs[p.addr] || 0)) return 'REPLAY'                      // monotonic
  if (!p.topic.startsWith(`floodboy/${p.addr.toLowerCase()}/`)) return 'BAD_TOPIC' // ACL
  lastTs[p.addr] = p.ts
  return 'OK'
}

// ---- DEMO ----
const account = privateKeyToAccount(generatePrivateKey())
const topic = `floodboy/${account.address.toLowerCase()}/readings`

const good = await signReading(account, topic, { waterDepthMm: 142 })
console.log('valid   ->', await verify(good))                 // OK

const tampered = { ...good, data: { waterDepthMm: 999 } }     // เปลี่ยนค่าหลังเซ็น
console.log('tampered->', await verify(tampered))             // BAD_SIG

console.log('replay  ->', await verify(good))                 // REPLAY (ts ไม่ monotonic)

// ---- MQTT wiring (ของจริงต่อ broker — vanilla Mosquitto/EMQX) ----
// import mqtt from 'mqtt'
// device:   client.publish(p.topic, JSON.stringify(p))
// verifier: client.subscribe('floodboy/+/readings')
//           client.on('message', async (_t, m) => {
//             const p = JSON.parse(m.toString())
//             const r = await verify(p)
//             if (r === 'OK') client.publish(`trusted/${p.topic}`, m) // republish to trusted broker (bridge)
//             else console.warn('drop', r)
//           })
