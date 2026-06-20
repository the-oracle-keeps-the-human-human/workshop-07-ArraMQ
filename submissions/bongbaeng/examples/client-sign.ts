// ARRA-MQ — client: sign message + publish (plain MQTT client + viem)
import { keccak256, toHex, type WalletClient } from 'viem'
import mqtt from 'mqtt'

const SALT_URL = 'https://arra-mq.example.workers.dev/salt'
const PREFIX = 'arra-mqtt/v1'

const client = mqtt.connect('mqtt://broker:1883')   // broker อะไรก็ได้ (Mosquitto/NanoMQ/EMQX)

// telemetry: ไม่ต้อง seq · control: ใส่ seq เพิ่มขึ้นเรื่อยๆ
let seq = 0

async function publishSigned(
  wallet: WalletClient, addr: `0x${string}`,
  topic: string, payload: string, isControl = false,
) {
  // 1. ดึง salt ปัจจุบัน (cache ได้ตลอด window)
  const { salt } = await (await fetch(SALT_URL)).json()

  // 2. ประกอบ body แล้วเซ็นคลุมทั้งก้อน (ts + topic + payloadHash + salt)
  const body: any = {
    v: PREFIX, addr, topic,
    ts: Math.floor(Date.now() / 1000),
    salt, dh: keccak256(toHex(payload)),
  }
  if (isControl) body.seq = ++seq            // control → monotonic seq

  const sig = await wallet.signMessage({
    account: addr, message: JSON.stringify(body),
  })

  // 3. publish { body, payload, sig } → subscriber/Worker verify เอง
  client.publish(topic, JSON.stringify({ body, payload, sig }))
}

// ใช้งาน:
// await publishSigned(wallet, addr, 'telemetry/temp', '27.5')          // telemetry
// await publishSigned(wallet, addr, 'ctl/door', 'OPEN', true)          // control (มี seq)
