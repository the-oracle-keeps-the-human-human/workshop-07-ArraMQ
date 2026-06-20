import { keccak256, stringToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ARRA_MQ_DOMAIN, ARRA_MQ_TYPES } from './typed-data'

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`)
const topic = `arra/v1/${account.address}/telemetry`
const data = { temp: 25.5 }
const body = {
  v: 1n,
  from: account.address,
  topic,
  ts: BigInt(Math.floor(Date.now() / 1000)),
  seq: BigInt(process.env.SEQ ?? '1'),
  dataHash: keccak256(stringToHex(JSON.stringify(data))),
}

const sig = await account.signTypedData({
  domain: ARRA_MQ_DOMAIN,
  types: ARRA_MQ_TYPES,
  primaryType: 'ArraMessage',
  message: body,
})

console.log(JSON.stringify({
  topic,
  payload: { ...body, data, sig, ts: Number(body.ts), seq: Number(body.seq) },
}, null, 2))
