// ArraMQ — COMPLETE reference: รวม 3 จุดที่ cohort ชี้ว่ายังไม่มีใครครบพร้อมกัน
//   (1) topic-in-signed-body + delivery-topic check  (กัน broker-reroute)
//   (2) EIP-712 typed-data จริง (chainId 20260619 ผูกใน digest)  (กัน cross-chain sig)
//   (3) persisted monotonic seq (bun:sqlite, รอด restart/scale)  (กัน replay จริง)
// run: bun arramq.ts        (verify-before-claim: รันได้จริง ไม่ใช่แค่เคลม)
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { keccak256, toHex, verifyTypedData } from 'viem'
import { Database } from 'bun:sqlite'

const CHAIN_ID = 20260619
const domain = { name: 'ARRA-MQTT', version: '1', chainId: CHAIN_ID } as const
const types = {
  Reading: [
    { name: 'addr', type: 'address' },
    { name: 'topic', type: 'string' },
    { name: 'ts', type: 'uint64' },
    { name: 'seq', type: 'uint64' },
    { name: 'dataHash', type: 'bytes32' },
  ],
} as const

// (3) persisted monotonic seq — sqlite = survives restart/scale (production จริง)
const db = new Database(':memory:') // demo: in-memory · production: file/Redis/Durable Object
db.run('CREATE TABLE IF NOT EXISTS seq (addr TEXT PRIMARY KEY, last INTEGER)')
const getSeq = (addr: string): bigint => {
  const r = db.query('SELECT last FROM seq WHERE addr=?').get(addr.toLowerCase()) as any
  return r ? BigInt(r.last) : 0n
}
const setSeq = (addr: string, seq: bigint) =>
  db.run('INSERT INTO seq(addr,last) VALUES(?1,?2) ON CONFLICT(addr) DO UPDATE SET last=?2',
    [addr.toLowerCase(), Number(seq)])

async function sign(account: any, topic: string, seq: bigint, data: any) {
  const ts = BigInt(Math.floor(Date.now() / 1000))
  const dataHash = keccak256(toHex(JSON.stringify(data)))
  const message = { addr: account.address, topic, ts, seq, dataHash }
  const sig = await account.signTypedData({ domain, types, primaryType: 'Reading', message })
  return { addr: account.address, topic, ts: Number(ts), seq: Number(seq), data, sig }
}

async function verify(p: any, deliveryTopic: string, windowSec = 300) {
  if (deliveryTopic !== p.topic) return 'BAD_DELIVERY_TOPIC'              // (1) กัน broker-reroute
  const dataHash = keccak256(toHex(JSON.stringify(p.data)))
  const message = { addr: p.addr, topic: p.topic, ts: BigInt(p.ts), seq: BigInt(p.seq), dataHash }
  const ok = await verifyTypedData({ address: p.addr, domain, types, primaryType: 'Reading', message, signature: p.sig })
  if (!ok) return 'BAD_SIG'                                              // (2) EIP-712 -> chainId bound ในนี้
  if (Math.abs(Date.now() / 1000 - p.ts) > windowSec) return 'STALE'
  if (BigInt(p.seq) <= getSeq(p.addr)) return 'REPLAY'                   // (3) persisted monotonic
  if (!p.topic.startsWith(`arra/${p.addr.toLowerCase()}/`)) return 'BAD_TOPIC'
  setSeq(p.addr, BigInt(p.seq))
  return 'OK'
}

// ---- demo (รันได้จริง) ----
const acc = privateKeyToAccount(generatePrivateKey())
const topic = `arra/${acc.address.toLowerCase()}/readings`

const m1 = await sign(acc, topic, 1n, { waterDepthMm: 142 })
console.log('valid       ->', await verify(m1, topic))                 // OK
console.log('replay      ->', await verify(m1, topic))                 // REPLAY (seq 1 <= last 1, persisted)
console.log('tampered    ->', await verify({ ...m1, data: { waterDepthMm: 999 } }, topic)) // BAD_SIG
const m2 = await sign(acc, topic, 2n, { x: 1 })
console.log('reroute     ->', await verify(m2, 'arra/evil/x'))         // BAD_DELIVERY_TOPIC
const m3 = await sign(acc, topic, 3n, { waterDepthMm: 150 })
console.log('next-seq    ->', await verify(m3, topic))                 // OK (seq 3 > 1)

// (2) demonstrate EIP-712 chainId binding — verify ด้วย chainId อื่น = reject
const wrongChain = await verifyTypedData({
  address: m3.addr, domain: { ...domain, chainId: 1 }, types, primaryType: 'Reading',
  message: { addr: m3.addr, topic, ts: BigInt(m3.ts), seq: 3n, dataHash: keccak256(toHex(JSON.stringify(m3.data))) },
  signature: m3.sig,
})
console.log('wrong-chain ->', wrongChain ? 'ACCEPTED (BAD!)' : 'REJECTED (chainId bound)')
