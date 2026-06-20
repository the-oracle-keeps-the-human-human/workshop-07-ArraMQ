// ARRA-MQ — SIWE verify on Cloudflare Worker (viem)
// verify ที่ "app-layer" → broker ตัวไหนก็ได้ ไม่แตะ core
// endpoints: GET /salt (rotating salt) · POST /verify { body, payload, sig }
import { recoverMessageAddress, keccak256, toHex } from 'viem'

interface Env { STATE: KVNamespace }           // CF KV / Durable Object
const WINDOW_PAST = 120, WINDOW_FUTURE = 30      // 2-sided ts window (sec)

const deny = (r: string) => Response.json({ ok: false, reason: r }, { status: 401 })

async function currentSalts(env: Env): Promise<string[]> {
  // salt หมุนทุก 60s — เก็บ current + previous (กัน boundary)
  const cur = await env.STATE.get('salt:cur')
  const prev = await env.STATE.get('salt:prev')
  return [cur, prev].filter(Boolean) as string[]
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === '/salt') {
      const salts = await currentSalts(env)
      return Response.json({ salt: salts[0] })   // ปัจจุบัน
    }

    if (url.pathname === '/verify' && req.method === 'POST') {
      const { body, payload, sig } = await req.json() as any

      // 1. recover ผู้ส่งจาก signature
      const who = await recoverMessageAddress({
        message: JSON.stringify(body), signature: sig,
      })
      if (who.toLowerCase() !== body.addr.toLowerCase()) return deny('addr')

      // 2. payload ผูกกับ sig (กันสลับ data)
      if (body.dh !== keccak256(toHex(payload))) return deny('payload')

      // 3. 2-sided time window (กัน too-old + pre-sign อนาคต)
      const now = Math.floor(Date.now() / 1000)
      if (body.ts < now - WINDOW_PAST || body.ts > now + WINDOW_FUTURE) return deny('time')

      // 4. salt window (replay bound ~salt lifetime)
      if (!(await currentSalts(env)).includes(body.salt)) return deny('salt')

      // 5. control topic → monotonic seq (กัน replay สนิท)
      if (body.topic.startsWith('ctl/')) {
        const last = Number(await env.STATE.get(`seq:${who}`) ?? 0)
        if (typeof body.seq !== 'number' || body.seq <= last) return deny('seq')
        await env.STATE.put(`seq:${who}`, String(body.seq))
      }

      return Response.json({ ok: true, addr: who })   // ✅ verified
    }
    return new Response('not found', { status: 404 })
  },

  // rotate salt ทุก 60s (Cron Trigger)
  async scheduled(_e: ScheduledEvent, env: Env) {
    const cur = await env.STATE.get('salt:cur')
    if (cur) await env.STATE.put('salt:prev', cur)
    await env.STATE.put('salt:cur', crypto.randomUUID())
  },
}
