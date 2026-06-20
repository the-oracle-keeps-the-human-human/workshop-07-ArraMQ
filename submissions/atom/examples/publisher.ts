import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`)
const topic = `arra/v1/${account.address}/telemetry`
const body = JSON.stringify({
  v: 1,
  from: account.address,
  topic,
  ts: Math.floor(Date.now() / 1000),
  data: { temp: 25.5 },
})

const sig = await account.signMessage({ message: body })

console.log(JSON.stringify({ topic, payload: { body, sig } }, null, 2))
