# ARRA-MQ — Proposal (ChaiKlang / ชายกลาง 🦁)

> SIWE / EIP-712 authenticated MQTT — **identity lives in the signed message, not the broker.**
> AI author (Rule 6). Design converged with BM, 2026-06-20.

## 1. แนวคิดหลัก (the one idea)
**Trust อยู่ใน signed message ไม่ใช่ที่ broker.** ทุก payload เซ็นด้วย Ethereum key (EIP-712, domain `ARRA-MQTT`) → ปลายทาง `recover` address จาก signature ก็รู้ว่าใครส่ง + ของจริงไหม. ผลคือ **broker เป็นแค่ท่อขนส่งโง่ๆ** → ใช้ EMQX / NanoMQ / Mosquitto / bridge mesh ตัวไหน topology ไหนก็ได้ (decentralized-friendly).

## 2. ทำไมต้องสร้าง (gap)
SIWE (EIP-4361) มี · MQTT broker auth (JWT/HTTP) มี · **แต่ยังไม่มีใครต่อ 2 อันเป็น package** (verified ด้วย web search 2026-06-20). ARRA-MQ = bridge ที่ขาดอยู่นั้น.

## 3. Design (simple where possible, anti-replay where needed)

### 3.1 Connect auth — time-based, stateless
```
username = ETH address
password = sign(EIP-712{ address, issued_at })   domain = ARRA-MQTT
broker (EMQX HTTP-auth) → verifier: recover address + (now - issued_at) < maxAge ~5m
→ ไม่มี nonce store, ไม่มี round-trip
```

### 3.2 Per-message — EIP-712 signed payload (self-proving)
```
payload = { data, ts, sig }   sig = EIP-712 sign(domain ARRA-MQTT, { data, ts })
consumer verify → recover address → รู้ผู้ส่ง · replay เก่า = ts บอกว่าเก่า (telemetry ปลอดภัย)
```

### 3.3 Control command — + monotonic counter (anti-replay)
```
payload = { cmd, seq, sig }
server: reject ถ้า seq <= last_seq[address]   (เก็บ int เดียวต่อ device)
→ กัน replay คำสั่ง "เปิด/ปิด" โดยไม่ต้อง nonce round-trip / ไม่พึ่ง clock
```

### 3.4 ACL — on-chain registry
address → topic permission อ่านจาก contract บน **ARRA L2 (chainId 20260619)** (หรือ off-chain map สำหรับ PoC). EMQX authz enforce.

### 3.5 Security
- **EIP-712 domain `ARRA-MQTT` v1 + chainId 20260619** → domain separation = กัน cross-domain/chain replay ในตัว
- TLS เสมอ (กัน sniff)
- bridge link = static service cred; per-message sig รอดข้าม bridge = end-to-end integrity

## 4. Core code (viem — ทั้งหมดอยู่ที่ message level)
```ts
import { privateKeyToAccount } from 'viem/accounts'
import { recoverTypedDataAddress } from 'viem'
const domain = { name: 'ARRA-MQTT', version: '1', chainId: 20260619 } as const
const types  = { Msg: [{ name: 'data', type: 'string' }, { name: 'ts', type: 'uint256' }] } as const

const acct = privateKeyToAccount(DEVICE_KEY)
async function signMsg(data: string) {
  const ts = BigInt(Date.now())
  const sig = await acct.signTypedData({ domain, types, primaryType: 'Msg', message: { data, ts } })
  return JSON.stringify({ data, ts: ts.toString(), sig })
}
async function verify(packet: string, maxAgeMs = 300_000) {
  const { data, ts, sig } = JSON.parse(packet)
  const addr = await recoverTypedDataAddress({ domain, types, primaryType: 'Msg',
    message: { data, ts: BigInt(ts) }, signature: sig })
  if (Date.now() - Number(ts) > maxAgeMs) return null
  return addr  // verified sender
}
```

## 5. Stack
- broker: **EMQX** (central, cluster, HTTP auth) + **NanoMQ** (edge, native HTTP auth, QUIC bridge) / Mosquitto
- verifier: tiny **Bun/Node** service (CF Worker-friendly) — recover EIP-712 + freshness + counter (KV)
- client: **viem** signer
- chain: **ARRA L2** (20260619) — ACL registry + identity domain

## 6. Economics
Edge NanoMQ รวบ device → bridge ขึ้น EMQX(/Cloud) → Cloud เห็นแค่จำนวน gateway (ไม่ใช่ทุก device) = ลด connection/traffic quota เยอะ.

## 7. PoC (Definition of Done)
`docker-compose up` → EMQX + verifier + client signer + (NanoMQ edge + bridge) →
- เซ็น telemetry → consumer verify ✅
- control command → counter กัน replay ✅
- bad/expired/replayed sig → reject ✅
- (stretch) ACL จาก on-chain registry

## 8. แผน
proposal นี้ (PR) → feedback → build PoC → PR ตามด้วยโค้ดรันได้ + Makefile/compose

— ChaiKlang Oracle (ชายกลาง) · AI, Rule 6
