// ARRA-MQ — SIWE verify on Cloudflare Worker (viem, EIP-712 default)
// ครบทั้ง 3: topic-in-signed-body + EIP-712 จริง (chainId เข้า digest) + persisted seq (KV/DO)
// verify ที่ "app-layer" → broker ตัวไหนก็ได้ ไม่แตะ core
// endpoints: GET /salt · POST /verify { msg, payload, sig, deliveryTopic }
import { recoverTypedDataAddress, keccak256, toHex } from 'viem'

interface Env { STATE: KVNamespace }
const WINDOW_PAST = 120, WINDOW_FUTURE = 30

// EIP-712 — chainId ผูกใน domain → cross-chain/domain replay กันที่ระดับ crypto (ไม่ใช่แค่ string prefix)
const DOMAIN = { name: 'ARRA-MQTT', version: '1', chainId: 20260619 } as const
const TYPES = {
  Message: [
    { name: 'from', type: 'address' },
    { name: 'topic', type: 'string' },
    { name: 'ts', type: 'uint64' },
    { name: 'salt', type: 'bytes32' },
    { name: 'dataHash', type: 'bytes32' },
    { name: 'seq', type: 'uint64' },        // 0 = telemetry, >0 = control
  ],
} as const

const deny = (r: string) => Response.json({ ok: false, reason: r }, { status: 401 })

async function currentSalts(env: Env): Promise<string[]> {
  const cur = await env.STATE.get('salt:cur')
  const prev = await env.STATE.get('salt:prev')
  return [cur, prev].filter(Boolean) as string[]
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/salt') {
      return Response.json({ salt: (await currentSalts(env))[0] })
    }
    if (url.pathname === '/verify' && req.method === 'POST') {
      const { msg, payload, sig, deliveryTopic } = await req.json() as any

      // 1. recover ผู้ส่งจาก EIP-712 signature (domain ผูก chainId 20260619)
      const who = await recoverTypedDataAddress({
        domain: DOMAIN, types: TYPES, primaryType: 'Message',
        message: msg, signature: sig,
      })
      if (who.toLowerCase() !== msg.from.toLowerCase()) return deny('addr')

      // 2. topic-binding — delivery topic ต้องตรง topic ใน signed body (กัน broker reroute)
      if (deliveryTopic && deliveryTopic !== msg.topic) return deny('topic_reroute')

      // 3. payload ผูก sig (กันสลับ data)
      if (msg.dataHash !== keccak256(toHex(payload))) return deny('payload')

      // 4. 2-sided time window (too-old + pre-sign อนาคต)
      const now = Math.floor(Date.now() / 1000)
      if (Number(msg.ts) < now - WINDOW_PAST || Number(msg.ts) > now + WINDOW_FUTURE) return deny('time')

      // 5. salt window (replay bound ~salt lifetime)
      if (!(await currentSalts(env)).includes(msg.salt)) return deny('salt')

      // 6. control (seq>0) → monotonic seq, PERSISTED ใน KV/DO (รอด restart/scale)
      if (Number(msg.seq) > 0) {
        const last = Number(await env.STATE.get(`seq:${who}`) ?? 0)
        if (Number(msg.seq) <= last) return deny('seq')
        await env.STATE.put(`seq:${who}`, String(msg.seq))
      }
      return Response.json({ ok: true, addr: who })
    }
    return new Response('not found', { status: 404 })
  },

  async scheduled(_e: ScheduledEvent, env: Env) {     // rotate salt ทุก 60s
    const cur = await env.STATE.get('salt:cur')
    if (cur) await env.STATE.put('salt:prev', cur)
    await env.STATE.put('salt:cur', '0x' + crypto.randomUUID().replace(/-/g, '').padEnd(64, '0'))
  },
}
