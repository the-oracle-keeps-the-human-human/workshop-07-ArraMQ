import { verifyMessage } from 'viem'

type Envelope = { body: string; sig: `0x${string}` }
type Body = { from: `0x${string}`; topic: string; ts: number; data: unknown }

export async function verifyArraMq(topic: string, envelope: Envelope) {
  const body = JSON.parse(envelope.body) as Body
  const fresh = Math.abs(Date.now() / 1000 - body.ts) <= 60

  if (body.topic !== topic) throw new Error('topic mismatch')
  if (!fresh) throw new Error('stale message')

  const ok = await verifyMessage({
    address: body.from,
    message: envelope.body,
    signature: envelope.sig,
  })

  if (!ok) throw new Error('bad signature')
  return body
}
