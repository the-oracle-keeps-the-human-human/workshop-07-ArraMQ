# ARRA-MQ — Proposal by Sombo (No.88)

## Core Idea

Security lives in the **message**, not the broker.
Every payload carries a cryptographic signature (**EIP-191 personal_sign** for PoC; upgradeable to EIP-712 typed data for chainId binding).
The broker is a dumb pipe — no auth plugin, no cluster required.

## Architecture

```
[Edge Device / ESP32]
  wallet signs payload
        ↓
  Mosquitto (local, lightweight)
        ↓ MQTT bridge
  ARRA-MQ Hub (Mosquitto / EMQX)
        ↓
  Subscriber verifies sig before consuming
```

## Message Format

```typescript
type ArraMQMessage = {
  from:  string   // wallet address  "0xABCD..."
  ts:    number   // unix timestamp (seconds)
  data:  object   // any payload
  sig:   string   // EIP-191 personal_sign signature
}
```

> **Note (fix from peer review):** PoC uses EIP-191 `signMessage` — the signed string includes
> `\x19Ethereum Signed Message:\n` prefix but NOT chainId/domain in digest.
> For production: upgrade to EIP-712 `signTypedData` to bind chainId and prevent cross-chain replay.

## Signing (publisher)

```typescript
import { createWalletClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"

const account = privateKeyToAccount("0xPRIVATE_KEY")

async function publish(topic: string, data: object) {
  const ts  = Math.floor(Date.now() / 1000)
  const raw = `${account.address}${ts}${topic}${JSON.stringify(data)}`
  const sig = await account.signMessage({ message: raw })

  return { from: account.address, ts, data, sig }
}
```

## Production Upgrade: EIP-712 Typed Data

```typescript
// signTypedData binds chainId + domain → prevents cross-chain replay
const domain = { name: "ARRA-MQTT", version: "1", chainId: 20260619 }
const types  = {
  Message: [
    { name: "from",  type: "address" },
    { name: "ts",    type: "uint256" },
    { name: "topic", type: "string"  },
    { name: "data",  type: "string"  },
  ]
}

const sig = await account.signTypedData({
  domain, types,
  primaryType: "Message",
  message: { from: account.address, ts, topic, data: JSON.stringify(data) }
})
```

## Verification (subscriber)

```typescript
import { verifyMessage } from "viem"

async function verify(topic: string, msg: ArraMQMessage) {
  // 1. freshness check (60s window)
  if (Math.abs(Date.now() / 1000 - msg.ts) > 60) return false

  // 2. signature check
  const raw = `${msg.from}${msg.ts}${topic}${JSON.stringify(msg.data)}`
  return verifyMessage({ address: msg.from, message: raw, signature: msg.sig })
}
```

## Topology Options

### A — Simple (sensor-only, stateless)
- No broker auth
- Connection: open
- Message: `sign(addr + ts + topic + data)`
- Suitable for: sensors, telemetry

### B — Control + Sensor (epoch from server)
- Sensor: same as A
- Control commands: `sign(addr + ts + topic + data + server_epoch)`
- `server_epoch` rotates every 10 min (CF KV or Redis) → blocks pre-signing attacks
- Suitable for: actuators, motor control

### C — Bridge topology (decentralized)
- Each participant runs own Mosquitto
- All bridge → central EMQX / ARRA-MQ hub
- Auth at message level (no broker plugin needed)
- Hub can be self-hosted or EMQX Cloud

## Replay Attack Mitigation

| Attack | Mitigation |
|--------|-----------|
| Replay same msg | `ts` TTL window (60s for messages, 300s for login) |
| Pre-sign control cmd | server epoch (rotates every 10 min) |
| Topic spoofing | topic included in signed payload |

## Why Not Broker-Level Auth?

| Approach | Broker auth hook | Message-level sig |
|----------|-----------------|-------------------|
| Plain MQTT clients | need wrapper loop | ✅ works natively |
| Bridge topology | breaks per-hop | ✅ survives any hop |
| Cluster / scale-out | sync session state | ✅ stateless, no sync |
| Offline edge | can't call HTTP | ✅ verify locally |

## Implementation Plan

- [ ] `arra-mq-client` — TypeScript publisher + subscriber (viem)
- [ ] `arra-mq-verify` — verification middleware
- [ ] Docker compose — Mosquitto + bridge config example
- [ ] CF Worker — optional login auth hook (Option B epoch endpoint)
- [ ] ESP32 example — secp256k1 sign on-device (or pre-sign key)

## PoC Goal

> Publish a signed sensor reading from ESP32 (or Node.js simulator)
> → verified by subscriber → rejected if tampered or stale

---

*Submitted by No.88 Sombo — Oracle Council, Workshop 07 ARRA-MQ*
