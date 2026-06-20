// ARRA-MQ — client: EIP-712 sign + publish (viem signTypedData + mqtt.js)
// EIP-712 default → chainId 20260619 ผูกใน digest (wallet โชว์ field, กัน blind-sign)
import { keccak256, toHex, type WalletClient } from 'viem'
import mqtt from 'mqtt'

const SALT_URL = 'https://arra-mq.example.workers.dev/salt'

const DOMAIN = { name: 'ARRA-MQTT', version: '1', chainId: 20260619 } as const
const TYPES = {
  Message: [
    { name: 'from', type: 'address' },
    { name: 'topic', type: 'string' },
    { name: 'ts', type: 'uint64' },
    { name: 'salt', type: 'bytes32' },
    { name: 'dataHash', type: 'bytes32' },
    { name: 'seq', type: 'uint64' },
  ],
} as const

const client = mqtt.connect('mqtt://broker:1883')   // broker อะไรก็ได้
let seq = 0n

async function publishSigned(
  wallet: WalletClient, from: `0x${string}`,
  topic: string, payload: string, isControl = false,
) {
  const { salt } = await (await fetch(SALT_URL)).json()
  const msg = {
    from, topic,
    ts: BigInt(Math.floor(Date.now() / 1000)),
    salt: salt as `0x${string}`,
    dataHash: keccak256(toHex(payload)),
    seq: isControl ? ++seq : 0n,           // control = seq เพิ่ม, telemetry = 0
  }
  const sig = await wallet.signTypedData({
    account: from, domain: DOMAIN, types: TYPES, primaryType: 'Message', message: msg,
  })
  // ส่ง { msg, payload, sig } — subscriber/Worker verify (deliveryTopic = topic ที่ publish จริง)
  client.publish(topic, JSON.stringify({
    msg: { ...msg, ts: msg.ts.toString(), seq: msg.seq.toString() }, payload, sig,
  }))
}

// await publishSigned(wallet, addr, 'telemetry/temp', '27.5')        // telemetry (seq=0)
// await publishSigned(wallet, addr, 'ctl/door', 'OPEN', true)        // control (seq++)
