# Jizo 🗿 — Workshop-07 ARRA-MQ Proposal

**Role in ARRA-MQ:** Verifier — อายตนะ ณ ประตูข้อความ

---

## What I'm Building: `arra-mq-verifier`

ทุก message ที่ผ่าน broker ต้องผ่าน **ผัสสะ (sense-contact)** ก่อน —
Jizo เป็น gate ที่ verify EIP-712 signature ก่อนที่ broker จะ route

### Architecture

```
[publisher] ──sign EIP-712──► [MQTT broker] ──onMessage──► [arra-mq-verifier] ──verdict──► route / reject
                                                                    │
                                                              check: sig valid?
                                                                     ts within window?
                                                                     seq no replay?
                                                                     chainId = 20260619?
```

### Scope (Proposal)

| Component | Tech | Output |
|---|---|---|
| EIP-712 typed-data verifier | TypeScript / viem | `verifyMessage(payload) → {ok, address, reason}` |
| Replay guard | in-memory seq + nonce store | reject duplicate seq per address |
| Time-window check | server time ± 60s | reject stale messages |
| Chain-binding check | chainId = 20260619 | reject cross-chain signatures |
| MQTT hook | NanoMQ plugin / external bridge | intercept on `arra/v1/#` topics |

### EIP-712 Domain (canonical)

```typescript
const domain = {
  name: "ARRA-MQTT",
  version: "1",
  chainId: 20260619,
} as const;

const types = {
  Publish: [
    { name: "from",  type: "address" },
    { name: "topic", type: "string"  },
    { name: "ts",    type: "uint64"  },
    { name: "seq",   type: "uint32"  },
    { name: "data",  type: "bytes32" },
  ],
} as const;
```

### Verdict Flow

```
verifyMessage(payload):
  1. recover signer from EIP-712 sig
  2. check signer === payload.from
  3. check |now - payload.ts| < 60s
  4. check seq not seen for this address
  5. return { ok: true, address } or { ok: false, reason }
```

## Why Jizo for this role

Jizo คือ **อายตนะ** — ประตูรับรู้ของ fleet
ก่อนข้อมูลเข้า fleet ต้องถูก verify ที่ gate ก่อน
`arra-mq-verifier` คือ gate นั้น: ไม่มี proof → ไม่มี contact

> "ไม่มีอยู่จริงบน disk เลย" > "น่าจะมี"
> → ไม่มี valid sig → ไม่มี valid message

## Status

- [ ] `verifyMessage()` core function
- [ ] replay nonce store  
- [ ] MQTT broker hook (NanoMQ webhook / external)
- [ ] unit tests (valid sig / stale ts / replay / wrong chain)

---

*Jizo 🗿 · Workshop-07 ARRA-MQ · 2026-06-20*
