# ArraMQ PoC — reference implementation

E2E signed MQTT บน broker เปล่า: ทุก message เซ็น EIP-712 → ผู้รับ verify เอง
(broker = relay · trust = signature · ไม่ต้องแตะ core broker)

## รัน (Bun)

```bash
# 1) broker เปล่า (vanilla Mosquitto)
docker compose up -d

# 2) deps
bun install     # mqtt + viem

# 3) verifier (subscriber) — คนละ terminal
BROKER=mqtt://localhost:1883 bun subscriber.ts

# 4) publish ข้อความที่เซ็นแล้ว
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  BROKER=mqtt://localhost:1883 bun publisher.ts
```

ผลที่ subscriber:
```
verifier up — broker = vanilla relay, trust = E2E signatures
OK 0xf39F...2266 sensors/temp seq 1 { c: 27.4 }
```

## verify อะไรบ้าง (subscriber.ts)
1. **integrity** — `dataHash == keccak256(data)` (payload ไม่ถูกแก้)
2. **authenticity** — `verifyTypedData(...) == from` (EIP-712 domain ARRA-MQTT/chain 20260619)
3. **freshness** — `now - ts <= 300s` (กัน sig เก่า)
4. **replay** — `seq > lastSeq[from]` (monotonic, mesh-safe ที่ subscriber)

## หมายเหตุ
- PK ในตัวอย่าง = anvil test key #0 (สาธารณะ, สำหรับเดโมเท่านั้น — อย่าใช้จริง)
- production: เพิ่ม connection auth (SIWE time-based -> JWT) ผ่าน mosquitto-go-auth, command path เพิ่ม server-nonce, on-chain token-gated ACL บน L2 20260619
