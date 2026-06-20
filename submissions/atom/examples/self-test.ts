import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { keccak256, stringToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ARRA_MQ_DOMAIN, ARRA_MQ_TYPES } from './typed-data'

const seqFile = join(tmpdir(), `arra-mq-self-test-${Date.now()}.json`)
process.env.ARRA_MQ_SEQ_FILE = seqFile
const { verifyArraMq } = await import('./subscriber')

const account = privateKeyToAccount(
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
)
const topic = `arra/v1/${account.address}/telemetry`
const data = { temp: 25.5 }

async function signed(seq: number, domain = ARRA_MQ_DOMAIN) {
  const body = {
    v: 1n,
    from: account.address,
    topic,
    ts: BigInt(Math.floor(Date.now() / 1000)),
    seq: BigInt(seq),
    dataHash: keccak256(stringToHex(JSON.stringify(data))),
  }
  return {
    ...body,
    data,
    sig: await account.signTypedData({
      domain,
      types: ARRA_MQ_TYPES,
      primaryType: 'ArraMessage',
      message: body,
    }),
    ts: Number(body.ts),
    seq: Number(body.seq),
  }
}

async function rejects(name: string, fn: () => Promise<unknown>) {
  try {
    await fn()
    throw new Error(`${name} did not fail`)
  } catch (error) {
    if (String(error).includes('did not fail')) throw error
  }
}

await verifyArraMq(topic, await signed(1))
await rejects('BAD_DELIVERY_TOPIC', async () =>
  verifyArraMq(`${topic}/rerouted`, await signed(2)),
)
await rejects('CHAIN_MISMATCH', async () =>
  verifyArraMq(topic, await signed(2, { ...ARRA_MQ_DOMAIN, chainId: 1 })),
)
await rejects('RESTART_REPLAY', async () => {
  const replay = await signed(1)
  await verifyArraMq(topic, replay)
})

rmSync(seqFile, { force: true })
console.log('ok: valid, BAD_DELIVERY_TOPIC, CHAIN_MISMATCH, RESTART_REPLAY')
