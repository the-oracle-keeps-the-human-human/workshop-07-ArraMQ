# ARRA-MQ — Proposal (bongbaeng)

> MQTT broker ที่ "รู้ว่าใครพูด" — auth + per-message proof ด้วย Sign-In-With-Ethereum
> โดย บ๊องแบ๊ง (bongbaeng) · Workshop-07 ArraMQ

## 1. แนวคิด (1 บรรทัด)
MQTT ที่ทุก message พิสูจน์ตัวตนผู้ส่งได้ด้วย Ethereum signature — auth = identity (ใครส่ง) ไม่ใช่ความลับ · broker ดีดทิ้งได้ตลอด

## 2. เป้าหมาย PoC
- client เซ็น message ด้วย wallet → ใครๆ verify ได้ว่ามาจาก address ไหน
- กัน replay (โดยเฉพาะ control command เปิด-ปิด) แบบ lightweight
- ใช้ของสำเร็จรูป (broker + CF Worker) — เขียนเองแค่ verify function

## 3. Auth Design (ตกผลึกกับพี่นัท)

### Connect / identity — timestamp-based (stateless)
- client sign `SIWE{ addr, issued_at=now, exp }` → MQTT `user=msg, pass=sig`
- verify (CF Worker): `ecrecover==addr` + `now-2m <= ts <= now+30s` (2-sided กัน pre-sign)

### Message-level — verify ที่ APP-LAYER (broker-agnostic)
```
sign:   body = { v:"arra-mqtt/v1", addr, topic, ts, salt, dh:keccak256(payload) }
        sig  = wallet.sign(JSON(body))
publish: { body, payload, sig }
verify (subscriber / CF Worker, viem):
  who = recoverMessageAddress(JSON(body), sig)
  who == body.addr · dh == keccak256(payload) · 2-sided ts window · salt ∈ {cur,prev}
```

### Replay defense — by data type
| data type | กลไก | เหตุผล |
|---|---|---|
| telemetry/sensor | timestamp + payload-bind | replay = อ่านซ้ำ ไม่อันตราย |
| control/actuator | + monotonic seq (server จำ last_seq/addr) | replay = สั่งซ้ำ อันตราย ต้องกันสนิท |

### Anti-replay เบา — rotating salt ("เกลือพริกไทย")
- server hold salt หมุนทุก ~60s (GET /salt, cache ได้) · เก็บ current+previous
- ทุกคน sign ด้วย salt ปัจจุบัน → replay bound แค่ salt lifetime · ไม่ต้อง nonce round-trip ต่อ message

## 4. Domain separation (กัน cross-context replay)
- prefix `arra-mqtt/v1` + topic ใน signed blob → sig ของ topic A / login ใช้ข้าม context ไม่ได้
- (option) EIP-712 typed data, domain `{ name:"ARRA-MQTT", version:"1", chainId:20260619 }`

## 5. Topology / Stack
```
[device] -> edge broker (NanoMQ / Mosquitto, เบา)
              | MQTT/QUIC bridge (off-the-shelf)
              v
          central EMQX (cluster) --hook--> CF Worker (viem verify)
verify SIWE = app-layer → broker ตัวไหนก็ได้ (ไม่แตะ core)
```
- Broker: EMQX (central, cluster+hook) · edge: NanoMQ (multi-core, rule-engine, QUIC) หรือ Mosquitto (เบา/คุ้น)
- Verify: CF Worker (Bun/Node) + viem `recoverMessageAddress`
- Salt/seq state: CF Worker KV / Durable Object

## 6. ทำไม design นี้ลงตัว (Simple/Compromise/PoC)
- simple: verify ที่ app-layer → ไม่เขียน broker plugin / ไม่แตะ core
- replay: telemetry = salt+ts พอ · control = seq ปิดสนิท
- เบา: server เก็บแค่ salt 2 ตัว + last_seq/client
- ของสำเร็จรูป: EMQX + edge broker + bridge + CF Worker · custom = verify ~100 บรรทัด

## 7. แผนงาน
1. ✅ Proposal (อันนี้)
2. ⏳ PoC: CF Worker verify (viem) + client wrapper sign + EMQX/NanoMQ + demo telemetry+control
3. ⏳ verify byte-for-byte ว่า sig ผ่าน/replay ถูก reject + README
4. ⏳ ส่ง PR + อัปเดต issue

🤖 by bongbaeng จาก ก้อง → bongbaeng-oracle
