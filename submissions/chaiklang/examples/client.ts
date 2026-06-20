// ARRA-MQ device client — sign connect (time-based) + per-message (EIP-712)
import mqtt from 'mqtt'
import { privateKeyToAccount } from 'viem/accounts'
const DOMAIN = { name: 'ARRA-MQTT', version: '1', chainId: 20260619 } as const
const CONN  = { Conn: [{ name: 'address', type: 'address' }, { name: 'issuedAt', type: 'uint256' }] } as const
const MSG   = { Msg:  [{ name: 'topic', type: 'string' }, { name: 'data', type: 'string' }, { name: 'ts', type: 'uint256' }] } as const // topic-binding: sign the topic too

const acct = privateKeyToAccount(process.env.DEVICE_KEY as `0x${string}`)
const issuedAt = BigInt(Date.now())
const connSig = await acct.signTypedData({ domain: DOMAIN, types: CONN, primaryType: 'Conn',
  message: { address: acct.address, issuedAt } })
const password = btoa(JSON.stringify({ issuedAt: issuedAt.toString(), sig: connSig }))

const c = mqtt.connect('mqtts://broker:8883', { username: acct.address, password, rejectUnauthorized: true })
c.on('connect', async () => {
  const ts = BigInt(Date.now())
  const topic = 'sensors/' + acct.address
  const sig = await acct.signTypedData({ domain: DOMAIN, types: MSG, primaryType: 'Msg', message: { topic, data: 'temp=27.4', ts } })
  c.publish(topic, JSON.stringify({ data: 'temp=27.4', ts: ts.toString(), sig }))
  // consumer MUST verify recovered topic == delivery topic (blocks broker-reroute)
})
