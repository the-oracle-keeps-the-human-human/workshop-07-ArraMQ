# ARRA-MQ reference PoC (Tinky ✨)

EIP-712 signed MQTT — **trust อยู่ในข้อความ ไม่ใช่ที่ broker**.
domain `ARRA-MQTT` · chainId `20260619` · 5-gate verifier + ⭐ revocation.

> เอกสารออกแบบเต็มอยู่ที่ `../PROPOSAL.md`

## ไฟล์

| ไฟล์ | หน้าที่ |
|---|---|
| `arramq.ts` | core — `signMessage()` + `verifyMessage()` (5 gate) |
| `selftest.ts` | ⭐ honest test 7 เคส — รันได้ทันที ไม่ต้องมี broker |
| `publisher.ts` | เซ็น EIP-712 + publish ผ่าน mqtt.js |
| `subscriber.ts` | subscribe + verify E2E ครบ 5 gate |
| `docker-compose.yml` + `mosquitto.conf` | Mosquitto เปล่า (path เต็ม) |

## ทางที่ 1 — zero-setup (พิสูจน์ logic, ไม่ต้องมี broker)

```bash
bun install
bun selftest.ts
```

รัน 7 เคส — happy path ✅ + 6 attack (tamper / replay / reroute / stale / not-in-ACL / **revoked key** ⭐).
เคส DENY ต้อง DENY จริง ไม่งั้น `exit 1`.

## ทางที่ 2 — end-to-end จริง (มี broker)

```bash
docker compose up -d           # Mosquitto vanilla
bun subscriber.ts &            # verifier (terminal 1)
bun publisher.ts               # ส่งข้อความเซ็น (terminal 2)
```

ทดสอบ revocation สดๆ — รัน subscriber โดยถอนสิทธิ publisher:

```bash
REVOKED=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 bun subscriber.ts
# → ทุกข้อความจาก publisher (คีย์ default) จะ ⛔ DENY @revocation แม้ลายเซ็นถูกต้อง
```

## 5 gate (ใน `verifyMessage`)

1. `recover(sig) == from` — authenticity + integrity (ครอบ tamper เพราะ dataHash คำนวณใหม่)
2. `topic` ใน payload == topic จริง — กัน reroute
3. `|now - ts| <= window` — freshness
4. `seq > lastSeq[from]` — anti-replay (monotonic)
5. `from ∈ ACL ∧ from ∉ revoked` — authorization + ⭐ revocation (คีย์รั่ว → ถอนได้)

---

*— Tinky Oracle ✨ `[ubuntu-dev-one:tinky]` — AI, Rule 6 🤖*
