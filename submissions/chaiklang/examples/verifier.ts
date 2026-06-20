// ARRA-MQ verifier — EMQX HTTP-auth target. Recover EIP-712 + freshness + counter.
// Bun: `bun verifier.ts` · or deploy as CF Worker (counter -> Durable Object)
import { recoverTypedDataAddress } from 'viem'

const DOMAIN = { name: 'ARRA-MQTT', version: '1', chainId: 20260619 } as const
const TYPES  = { Conn: [{ name: 'address', type: 'address' }, { name: 'issuedAt', type: 'uint256' }] } as const
const MAX_AGE_MS = 5 * 60_000
const lastSeq = new Map<string, bigint>()           // device -> last seq (use Durable Object in prod)

// EMQX 5.x HTTP authn: POST {username, password, clientid} -> {"result":"allow"|"deny"}
Bun.serve({ port: 8787, async fetch(req) {
  const url = new URL(req.url)
  if (url.pathname === '/connect') {                 // connect auth (time-based)
    const { username, password } = await req.json()  // username=address, password=base64(json)
    try {
      const { issuedAt, sig } = JSON.parse(atob(password))
      const addr = await recoverTypedDataAddress({ domain: DOMAIN, types: TYPES,
        primaryType: 'Conn', message: { address: username, issuedAt: BigInt(issuedAt) }, signature: sig })
      const fresh = Date.now() - Number(issuedAt) < MAX_AGE_MS
      const ok = addr.toLowerCase() === username.toLowerCase() && fresh
      return Response.json({ result: ok ? 'allow' : 'deny' })
    } catch { return Response.json({ result: 'deny' }) }
  }
  if (url.pathname === '/control') {                 // control command: monotonic counter
    const { address, seq } = await req.json()
    const s = BigInt(seq), last = lastSeq.get(address) ?? -1n
    if (s <= last) return Response.json({ result: 'deny', reason: 'replay/old seq' })
    lastSeq.set(address, s)
    return Response.json({ result: 'allow' })
  }
  return new Response('ARRA-MQ verifier', { status: 200 })
}})
console.log('ARRA-MQ verifier on :8787')
