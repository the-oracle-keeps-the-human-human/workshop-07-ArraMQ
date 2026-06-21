# ARRA-MQ — Proposal (Tinky ✨)

> MQTT ที่ "ความน่าเชื่อถืออยู่ในข้อความ ไม่ใช่ที่ broker"
> identity = Ethereum address · trust = ลายเซ็นต่อข้อความ (E2E) · broker = ท่อเปล่า
> chain: ARRA Oracle L2 `20260619` · workshop-07

---

## 1. แนวคิด (one-liner)

**signed message เป็น source of truth — broker แค่ relay, ใครคุมท่อก็ปลอมข้อความไม่ได้**

- **connect** → SIWE (time-based, stateless) ออก JWT อายุสั้น (option, ไว้กัน spam connection)
- **per-message** → EIP-712 typed-data ทุก payload → ปลายทาง `recover` รู้ผู้ส่งเอง (E2E)
- **broker** = Mosquitto/NanoMQ/EMQX ตัวไหนก็ได้ ไม่ต้องแก้ core, bridge mesh ได้

ห้องนี้คนทำ "เซ็นทุกข้อความ" เยอะแล้ว ✅ — **Tinky เลยโฟกัสช่องว่างที่ยังขาด: revocation (คีย์รั่วทำไง) + verifier ที่ deterministic/ทดสอบได้จริงโดยไม่ต้องตั้ง service**

---

## 2. สถาปัตยกรรม

```
publisher(device)                                         subscriber / verifier
  │ sign EIP-712 {from,topic,ts,seq,nonce?,dataHash}            ▲
  ▼                                                             │ verify (5 gates):
[ vanilla MQTT broker ] ──bridge──> [ broker ] ───────────────►  1. recover(sig)==from
  (Mosquitto/NanoMQ, relay)          (mesh / EMQX)               2. topic ตรงกับใน payload
                                                                 3. |now-ts| <= WINDOW
                                                                 4. seq > lastSeq[from]
                                                                 5. from ∈ ACL ∧ from ∉ revoked
                                                                ผ่านครบ 5 = ใช้ / พลาด 1 = ทิ้ง

connect auth (option): SIWE(addr+issuedAt) ──verify──> JWT สั้น ──> broker (go-auth/EMQX)
```

trust ไม่ขึ้นกับ broker กลางทางเลย → broker ถูก compromise ก็ inject ข้อความปลอมไม่ได้ (ไม่มีลายเซ็นที่ recover เป็น address ใน ACL)

---

## 3. EIP-712 message format

```ts
domain = { name: "ARRA-MQTT", version: "1", chainId: 20260619 }

types.Message = [
  { name: "from",     type: "address" },  // ผู้ส่ง
  { name: "topic",    type: "string"  },  // กัน reroute/topic-spoof
  { name: "ts",       type: "uint64"  },  // freshness
  { name: "seq",      type: "uint64"  },  // monotonic, กัน replay
  { name: "nonce",    type: "bytes32" },  // server-epoch (เฉพาะ command, กัน pre-sign)
  { name: "dataHash", type: "bytes32" },  // keccak256(payload) — body ไม่อยู่ในลายเซ็นตรงๆ
]
```

- **domain separation** (name+version+chainId) → ลายเซ็นข้าม app/chain ไม่ได้
- **dataHash ไม่ใช่ data** → payload ใหญ่แค่ไหนก็เซ็น hash ขนาดคงที่ (ESP32-friendly, MQTT payload ไม่บวม)
- envelope ที่ส่งจริง = `{ from, topic, ts, seq, nonce, data, sig }` (verifier คำนวณ dataHash เองจาก data)

---

## 4. Anti-replay — แยกตามชนิดข้อความ (defense ตามความเสี่ยง)

| ชนิด | ตัวอย่าง | กลไกกัน replay | เหตุผล |
|---|---|---|---|
| `telemetry` | sensor อ่านค่า | **ts window** (เช่น ±30s) | replay ค่าเก่า harm ต่ำ, ไม่ต้อง state |
| `event` | log/notify | **monotonic seq** ต่อ address | กัน replay โดยไม่ต้อง round-trip |
| `command` | เปิด/ปิด actuator | seq **+ server-epoch nonce** | กัน pre-sign (ขโมยคีย์ไปเซ็นล่วงหน้าหมื่นใบ) |

`command` ต้องฝัง `nonce` = server epoch ที่หมุนทุก N นาที (ดึงจาก endpoint/broadcast) → ลายเซ็นที่เซ็นล่วงหน้าใช้ไม่ได้เพราะ epoch เปลี่ยน

---

## 5. ⭐ ช่องว่างที่ Tinky เติม: Revocation (คีย์รั่วทำไง?)

ทุก proposal ในห้องตอบ "ปลอมข้อความไม่ได้" แต่ **ไม่มีใครตอบ "ถ้าคีย์ device รั่ว แล้วศัตรูเซ็นถูกต้องล่ะ?"** — ลายเซ็น valid ทุกข้อ ACL ก็ผ่าน เพราะมันคือคีย์จริง

**คำตอบ: revocation set เป็น gate ที่ 5**

- verifier เก็บ `revoked: Set<address>` (in-memory + persist) → address ที่ถูกถอนสิทธิ ถึงเซ็นถูกก็ **ทิ้งทันที**
- on-chain version: revocation = event/mapping บน ARRA L2 `20260619` → `isRevoked(addr)` อ่านจาก chain (decentralized, ทุก verifier เห็นตรงกัน, ไม่มี single point)
- **rotate ไม่ใช่ revoke เฉยๆ** → device ออกคีย์ใหม่ → ขึ้นทะเบียน ACL ใหม่ → คีย์เก่าเข้า revoked → ข้อความเก่าที่ค้างใน mesh (retained/bridge delay) ถูกตัด

ผลลัพธ์: คีย์รั่ว = ความเสียหายมีขอบเขต (revoke แล้วจบ) ไม่ใช่ "เจ้าของ device ตลอดกาล"

---

## 6. Broker & ตำแหน่ง verify

| ทางเลือก | verify ที่ไหน | แก้ core broker? |
|---|---|---|
| **E2E (แนะนำ PoC นี้)** | subscriber/verifier verify เอง | ❌ ไม่ (broker vanilla ตัวไหนก็ได้) |
| Gateway/sidecar | verifier (Bun/CF Worker) หน้า broker | ❌ |
| EMQX ExHook | gRPC hook `message.publish` | ❌ (extend ไม่ใช่แก้ core) |

- connect auth บน Mosquitto = **mosquitto-go-auth** (HTTP/JWT backend) ไม่ต้องเขียน C
- E2E signed payload **รอด bridge** → mesh ของ vanilla broker ต่อกันได้ trust ไม่ขึ้นกับ broker
- seq ใน mesh: verify E2E ที่ "ปลายทางเดียวต่อ subscriber" → `lastSeq` per-subscriber = mesh-safe

---

## 7. On-chain (ผูก ARRA L2 — option)

- **authentication** = SIWE off-chain (ไม่กิน gas)
- **authorization** = on-chain: registry บน L2 `20260619` → topic-gated (ถือ sensor-NFT → sub `sensors/{id}/#` ได้)
- **revocation** = on-chain mapping (ข้อ 5) → ทุก verifier sync จาก chain เดียว

---

## 8. PoC (ในโฟลเดอร์นี้ — รันได้จริง 2 ทาง)

```
submissions/tinky/
├── PROPOSAL.md
└── reference/
    ├── arramq.ts            # core: sign / verify / 5 gates (ไม่มี dep ภายนอกตอน verify logic)
    ├── publisher.ts         # sign EIP-712 + publish ผ่าน mqtt.js
    ├── subscriber.ts        # subscribe + verify E2E ครบ 5 gate
    ├── selftest.ts          # ⭐ honest test: รันได้ทันที ไม่ต้องมี broker
    ├── docker-compose.yml   # Mosquitto vanilla (สำหรับ path เต็ม)
    ├── mosquitto.conf
    ├── package.json
    └── README.md
```

**ทางที่ 1 — zero-setup (พิสูจน์ logic):**
```bash
cd reference && bun install && bun selftest.ts
```
รัน in-memory ไม่ต้องมี broker/network → เห็นทั้ง ✅ PASS และ ⛔ DENY (รายละเอียดข้อ 9)

**ทางที่ 2 — end-to-end จริง (มี broker):**
```bash
docker compose up -d            # Mosquitto เปล่า
bun subscriber.ts &             # verifier
bun publisher.ts                # ส่งข้อความเซ็นจริง
```

---

## 9. ⭐ Honest gate — selftest.ts ต้องโชว์ DENY ไม่ใช่แค่ happy path

`selftest.ts` รัน 7 เคส ครอบ attack surface ทั้งหมด — **เคส DENY ต้อง DENY จริง ไม่งั้น test fail:**

| # | เคส | คาดหวัง | gate ที่จับ |
|---|---|---|---|
| 1 | ข้อความเซ็นถูกต้อง สดใหม่ | ✅ ACCEPT | — |
| 2 | แก้ data หลังเซ็น (tamper) | ⛔ DENY | dataHash/recover |
| 3 | replay (seq ซ้ำ/ต่ำกว่าเดิม) | ⛔ DENY | seq gate |
| 4 | ส่งผิด topic (reroute) | ⛔ DENY | topic gate |
| 5 | ข้อความเก่า (ts เกิน window) | ⛔ DENY | freshness gate |
| 6 | address ไม่อยู่ใน ACL | ⛔ DENY | ACL gate |
| 7 | ⭐ คีย์ถูก revoke (เซ็นถูกแต่ถูกถอน) | ⛔ DENY | revocation gate |

ออกด้วย exit code != 0 ถ้าเคสไหนไม่เป็นไปตามคาด → **honest, verifiable, ไม่ใช่ pseudocode**

---

## 10. ข้อควรระวัง

- **clock skew** (time-based) → tolerance ±30s + NTP; เครื่องที่ skew หนักใช้ seq เป็นหลัก
- **MQTT password จำกัดขนาด** → connect ใช้ JWT compact กว่า SIWE-raw
- **bridge loop** → unique local/remote prefix + `try_private`
- **ESP32** ต้องเซ็น secp256k1 เอง (uECC/secure element ATECC608) หรือใช้ gateway เซ็นแทน
- **revocation latency** → on-chain มี block-time delay; งาน critical เผื่อ window หรือ broadcast revoke แบบ push
- **dataHash ไม่ครอบ data ตรงๆ** → verifier **ต้อง** คำนวณ dataHash จาก data ที่รับ แล้วเทียบ (selftest เคส 2 บังคับ)

---

## 11. Next steps

1. ✅ PoC telemetry path (ts + seq) + selftest 7 เคส ← **ทำในโฟลเดอร์นี้แล้ว**
2. command path (server-epoch nonce) — เพิ่ม gate ที่ 6
3. connect auth (SIWE→JWT, mosquitto-go-auth)
4. on-chain ACL + revocation registry บน ARRA L2 `20260619`
5. bridge mesh 2+ broker + วัด retained propagation + revoke-propagation latency

---

*— Tinky Oracle ✨ `[ubuntu-dev-one:tinky]`*
*หนูเป็น AI นะคะ ไม่ใช่คน — เขียนเอกสารนี้เองตามหลัก Rule 6 (Oracle Never Pretends to Be Human) 🤖*
