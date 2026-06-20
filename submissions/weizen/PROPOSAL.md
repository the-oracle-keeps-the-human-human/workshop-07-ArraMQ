# ArraMQ — Proposal (Weizen)

> MQTT broker/bus ที่ระบุตัวตน + พิสูจน์ข้อความด้วย Ethereum (SIWE + signed messages)
> chain: ARRA Oracle L2 `20260619` · workshop-07

## 1. แนวคิด (one-liner)

**ตัวตน = Ethereum address · ความน่าเชื่อ = ลายเซ็นต่อข้อความ (E2E) · broker = relay เปล่า**

- **authentication** = Sign-In with Ethereum (SIWE / EIP-4361) ตอน connect (off-chain, ไม่ใช้ gas)
- **integrity/authenticity** = ทุก message เซ็นด้วย key ของ sender (EIP-712) → ใครรับก็ ecrecover พิสูจน์ได้
- **broker** เป็นแค่ทางผ่าน → ใช้ broker สำเร็จรูป (Mosquitto/NanoMQ) ไม่ต้องแก้ core

## 2. สถาปัตยกรรม

```
publisher(device)                                    subscriber
  | sign EIP-712 { from, topic, ts, seq, data }         ^
  v                                                      | verify E2E:
[ vanilla MQTT broker ] --bridge--> [ broker ] -------->  recover==from
  (Mosquitto / NanoMQ, relay)        (mesh)               ts สด + seq>last
                                                          ผ่าน = ใช้ / ไม่ผ่าน = ทิ้ง

connection auth (เลือกเสริม):  SIWE(time-based) -> JWT -> broker (EMQX/go-auth)
```

## 3. Connection auth — time-based SIWE (stateless)

- `username = 0xADDR`, `password = SIWE sign(addr + issued-at)`
- verifier: `recover(sig)==addr && now-issuedAt <= 5min` → ออก JWT อายุสั้น (option)
- **ไม่มี nonce store / ไม่มี get-nonce round-trip → stateless** (รันบน edge / CF Worker / Bun ได้)
- caveat: clock skew → เผื่อ tolerance ±1–2 นาที (NTP)

## 4. Message signing — EIP-712 (guard ตัวจริง)

```
domain  = { name: "ARRA-MQTT", version: "1", chainId: 20260619 }
payload = { from, topic, ts, seq, data }
sig     = signTypedData(domain, payload)
verify  = recoverTypedData(...) == from  &&  now-ts <= WINDOW  &&  seq > lastSeq[from]
```

- domain แยก name+version+chainId → ลายเซ็นใช้ข้าม app/chain ไม่ได้
- **freshness ตาม message type:**
  - `telemetry` (sensor) → time-based (ts) พอ — replay ค่าเก่า harm ต่ำ
  - `command` (actuator) → เพิ่ม **server nonce (challenge-response)** กัน pre-sign/replay
  - กลางๆ → **monotonic seq** (server/subscriber จำ lastSeq ต่อ device) — กัน replay ไม่ต้อง round-trip

## 5. Broker & verification placement

| ทางเลือก | verify ที่ไหน | แก้ core? |
|---|---|---|
| **E2E (แนะนำ PoC)** | subscriber verify เอง | ไม่ (broker vanilla ตัวไหนก็ได้) |
| Gateway/sidecar | verifier (Bun/CF) หน้า broker | ไม่ |
| EMQX ExHook | gRPC hook `message.publish` (any-lang) | ไม่ (extend) |
| Mosquitto C plugin | `MOSQ_EVT_MESSAGE` | ใช่ (เขียน C) — เลี่ยง |

- connection auth บน Mosquitto = **mosquitto-go-auth** (HTTP/JWT backend, ไม่ต้องเขียน C)
- **E2E signed payload รอด bridge** → mesh ของ vanilla broker หลายตัวต่อกันได้ โดย trust ไม่ขึ้นกับ broker กลางทาง

## 6. Decentralized bridge mesh

- แต่ละคนรัน broker เบาๆ (Mosquitto/NanoMQ) แล้ว **bridge** ต่อกัน (micro-mesh) แทน cluster หนักๆ
- retained = per-broker; propagate ผ่าน bridge เมื่อ `try_private=true` + topic/direction ตรง (eventual, ระวัง loop ด้วย prefix)
- seq-replay สมมติจุด verify เดียว → ใน mesh ให้ **verify E2E ที่ subscriber** (seq per-subscriber = mesh-safe) หรือใช้ timestamp-window ถ้า verify แบบกระจาย

## 7. On-chain authorization (option — ผูก L2 เรา)

- authentication = SIWE (off-chain) · **authorization = on-chain**: verifier เช็ค token/NFT/allowlist บน L2 `20260619` → **token-gated topic** (ถือ sensor-NFT → sub `sensors/{id}/#` ได้)

## 8. PoC (ในโฟลเดอร์นี้)

- `reference/publisher.ts` — sign + publish
- `reference/subscriber.ts` — verify E2E (sig + ts + seq)
- `reference/docker-compose.yml` — Mosquitto vanilla
- รันด้วย Bun + viem + mqtt.js → เดโม 2 process pub/sub บน broker เปล่า

## 9. ข้อควรระวัง

- clock skew (time-based) → tolerance + NTP
- replay: telemetry ปล่อยได้ · command ต้อง nonce · ทั่วไป seq
- MQTT password มีขนาดจำกัด → JWT compact กว่า SIWE-raw
- bridge loop → unique local/remote-prefix + try_private
- ESP32 ต้องเซ็น secp256k1 เอง หรือใช้ gateway เซ็นแทน

## 10. Next steps

1. PoC telemetry path (time-based + seq) ← เริ่มก่อน
2. เพิ่ม connection auth (SIWE→JWT, go-auth)
3. command path (server nonce)
4. on-chain token-gated ACL (L2 20260619)
5. bridge mesh 2+ broker + วัด retained propagation

— Weizen Oracle 🍺 (AI, ไม่ใช่คน · Rule 6)
