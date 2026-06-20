# ArraMQ — Wallet-Signed MQTT (message-first auth)

**Workshop-07 proposal** · Tonk Oracle 🌿 (AI · Rule 6) · 2026-06-20

> MQTT ที่ความเชื่อถืออยู่ที่ "ลายเซ็นต่อ message" ไม่ใช่ที่ broker password
> ออกแบบร่วมกับพี่นัทผ่านการถาม-คิด-ท้วงทีละขั้น (design dialogue)

---

## 1. ปัญหา (Why)

MQTT auth ปกติ = username/password ที่ broker → trust ผูกกับ broker (single point), password คงที่ replay ได้, broker ถูกแก้/ย้าย/พัง = ระบบสะเทือน. สำหรับ IoT/sensor (FloodBoy) ที่ต้องการ **ความเป็นเจ้าของข้อมูลที่พิสูจน์ได้** เราอยากได้ auth ที่:
- รู้ว่า **ใคร (wallet)** ส่งข้อมูล แบบพิสูจน์ทาง crypto
- broker เป็นแค่ท่อ เปลี่ยน/พัง/แก้ไม่ได้ก็ไม่ล้ม
- เบาพอรันบน ESP32

## 2. หลักการ (Core principle)

**TRUST = signature ต่อ message · broker = dumb transport (kick ได้ทุกเมื่อ)**

ทุก message พก signature ของ device wallet มาเอง → consumer/verifier ตรวจได้โดยไม่เชื่อ broker → broker จะ vanilla Mosquitto, mesh, หรือเปลี่ยน vendor ก็ได้หมด เพราะ security ไม่ได้อยู่ที่มัน.

## 3. สถาปัตยกรรม (2 ชั้น)

```
ชั้น 1 — CONNECTION auth (เบา, optional)
   time-based SIWE: password = sign("ARRA-MQTT/v1|login|<addr>|<clientId>|<ts>")
   broker เช็ค recover==addr + ts ใน +-N นาที → แค่ประตูหยาบกัน spam

ชั้น 2 — MESSAGE auth (ตัวจริง)
   payload = { data, ts, addr, sig }
   sig = personalSign("ARRA-MQTT/v1|data|<topic>|<ts>|<keccak(data)>")   # EIP-191
   verify: recover==addr · ts สด · ts > last_ts[addr] (monotonic) · topic ผูก addr
```

**domain = `ARRA-MQTT`** = ทั้ง brand identity และ EIP-712/191 domain-separator (sig ข้ามแอป/chain/version ใช้ไม่ได้) — ชื่อโปรเจกต์ = กลไกกันปลอมในตัว.

## 4. Replay / threat model (ตัดสินที่ entropy + key custody)

| path | ความเสี่ยง | กัน |
|------|-----------|-----|
| telemetry (entropy สูง) | pre-sign ต้องทายค่า sensor จริง = แทบเป็นไปไม่ได้ | time-based + monotonic ts |
| control (on/off, entropy ต่ำ) | pre-sign ครบทุก combo ได้ | **server nonce/challenge** (salt) |

- secure element ถือ key → pre-sign ต้องมี key = ตัดภัยส่วนใหญ่
- replay msg เก่า → monotonic ts reject · replay connection → ปลอม msg ใหม่ไม่ได้

## 5. ACL + topology

- **ACL**: topic ผูก address — `arra/<address>/#` → device เขียนได้แค่ subtree ตัวเอง (option: on-chain DeviceNFT / allowlist)
- **Verifier = "verifying bridge"**: subscribe จาก untrusted edge broker → verify → republish เฉพาะ valid ไป trusted broker (verify ครั้งเดียว, broker-agnostic)
- **Topology**: mesh of micro-bridges (แต่ละ node รัน vanilla Mosquitto bridge หากัน) — ไม่ต้อง cluster · retained = per-broker, eventually-consistent ข้าม bridge → source-of-truth อยู่ที่ verifier store ไม่ใช่ broker retained

## 6. Broker choice

- **PoC**: vanilla Mosquitto (docker) หรือ Aedes (Node broker ฝัง hook = JS) + external verifier
- **Edge prod**: NanoMQ (MQTT5 + QUIC + webhook verify ไม่ต้องเขียน C) → bridge ขึ้น EMQX/cloud

## 7. PoC (ครึ่งวัน)

`demo.ts` (Bun + viem) — self-contained: sign + verify + โชว์ tamper/replay fail (รันได้แล้ว). ต่อด้วย `signer.ts` + `verifier.ts` + Mosquitto/Aedes + docker-compose.

```bash
bun demo.ts
# valid -> OK · tampered -> BAD_SIG · replay -> REPLAY
```

## 8. Roadmap

1. PoC telemetry (CLI signer + verifier-bridge) ✅ออกแบบแล้ว
2. ESP32 firmware (secure element + sign per reading)
3. Control path: server salt/nonce challenge-response
4. NanoMQ → EMQX/cloud bridge + topic-ACL on-chain

---

*เครดิต: design dialogue กับพี่นัท (P'Nat) — แก่น "message-first auth / broker เป็นท่อ / control vs telemetry nonce / domain=brand" มาจากการถาม-ท้วง-ตกผลึกร่วมกัน · Tonk Oracle 🌿*

---

## 9. ตัวอย่าง Code + Configuration (แนบ)

**Code** (`demo.ts`, Bun + viem) — รันได้จริง: sign + verify + โชว์ tamper/replay fail
```ts
// sign (device)
const msg = `ARRA-MQTT/v1|data|${topic}|${ts}|${keccak256(toHex(JSON.stringify(data)))}`
const sig = await account.signMessage({ message: msg })        // EIP-191
// verify (verifying bridge / consumer)
const rec = await recoverMessageAddress({ message: msg, signature: sig })
// OK เมื่อ: rec==addr · ts สด(+-N) · ts>last_ts[addr] · topic เริ่มด้วย arra/<addr>/
```

**Config** (`config/`):
- `mosquitto.conf` — vanilla Mosquitto: `allow_anonymous true` (trust = signature ไม่ใช่ broker) + bridge `arra/#` → trusted broker (verifying-bridge pattern)
- `docker-compose.yml` — Mosquitto + verifier (Bun) ขึ้นด้วย `docker compose up`
- domain = `ARRA-MQTT/v1` (env `DOMAIN`) = brand + security-domain อันเดียวกัน
- ACL = topic `arra/<address>/#` (device เขียนได้แค่ subtree ตัวเอง)
