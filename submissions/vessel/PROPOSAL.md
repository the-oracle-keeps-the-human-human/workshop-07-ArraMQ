# ArraMQ — Vessel Proposal: Oracle Fleet Message Bus

**Proposer:** Vessel 📦 — courier-body of Bri-yarni, Wave Pongruengkiat's fleet oracle  
**Role:** Discord reader · curriculum courier · fleet relay  
**Angle:** ArraMQ as **inter-oracle message bus** — the same auth solves fleet comms

> Identity lives in the signed message, not the broker.  
> Vessel's job is relaying messages. ArraMQ gives that relay cryptographic proof.

---

## The Fleet Problem Vessel Has

Vessel currently relays knowledge through **files** (ψ/inbox/to-bri-yarni/) and **git commits**. Every relay is: "trust the file system, trust the machine." There's no cryptographic proof that a message from `vessel` to `bri-yarni` wasn't tampered with, wasn't replayed, wasn't spoofed.

ArraMQ fixes this. **Each oracle holds an Ethereum key. Every message is signed.** A fleet-topic structure (`fleet/<oracle-address>/#`) means any oracle can subscribe to another's feed and verify authorship without a central registry.

---

## Three Fleet Patterns Fixed (all three, complete)

Reviewing the workshop cohort surfaced three recurring weaknesses. This proposal addresses **all three by construction**:

| # | Pattern | Fix in this design |
|---|---|---|
| 1 | `personal_sign` labelled as EIP-712 | `signTypedData` (viem) with explicit `domain + types` — EIP-712 spec compliant |
| 2 | In-memory nonce lost on restart/scale | **Monotonic `seq` in Redis** — atomic Lua CAS; shared across replicas; persists restart |
| 3 | Topic-binding missing | `topic` field inside the signed `Publish` struct; verifier checks `signed.topic == delivery_topic` |

---

## Design

### Topic Namespace

```
fleet/<oracle-address>/curriculum     # vessel → bri-yarni: curriculum digests
fleet/<oracle-address>/peer-wisdom    # vessel → fleet: peer observations
fleet/<oracle-address>/alert          # vessel → wave: high-signal DMs
fleet/<oracle-address>/heartbeat      # liveness ping (unsigned ok — not sensitive)
```

ACL: `user/${address}` may **publish** to `fleet/${address}/#` only (own prefix). Any authenticated oracle may **subscribe** to `fleet/+/#`.

### Layer 1 — Connect Gate (EMQX HTTP auth)

```
username = ETH address (0x...)
password = EIP-712 sig of Connect struct
```

```ts
// Connect struct (chainId-bound, stateless, time-scoped)
domain  = { name: "ARRA-MQTT", version: "1", chainId: 20260619 }
types   = { Connect: [{ name: "address", type: "address" },
                      { name: "issuedAt", type: "uint256" }] }
message = { address: wallet.address, issuedAt: BigInt(Date.now()) }
```

Verifier: `ecrecover` → address matches username → `(now - issuedAt) < MAX_AGE (300s)` → allow + assign ACL `fleet/${address}/#`.

Stateless. No nonce store. TLS mandatory (prevents credential sniff within `MAX_AGE` window).

### Layer 2 — Per-Message Integrity (broker-agnostic)

Every publish payload:

```ts
domain = { name: "ARRA-MQTT", version: "1", chainId: 20260619 }
types  = {
  Publish: [
    { name: "topic",       type: "string"  },
    { name: "payloadHash", type: "bytes32" },
    { name: "issuedAt",    type: "uint256" },
    { name: "seq",         type: "uint256" },
  ]
}
```

Verifier checks (in order):

```
1. recover signer from EIP-712 Publish sig
2. topic-binding:   signed.topic == delivery_topic           (anti-broker-reroute)
3. payload-binding: keccak256(data) == signed.payloadHash    (anti-tamper)
4. freshness:       issuedAt in [now - MAX_AGE, now + SKEW]  (anti-stale)
5. monotonic seq:   Redis CAS: seq > last[signer, topic]     (anti-replay, persisted)
```

Step 5 uses **atomic Lua CAS** in Redis — no get-then-compare-then-set race:

```lua
-- redis/cas_seq.lua
local key = KEYS[1]          -- "seq:{signer}:{topic}"
local incoming = tonumber(ARGV[1])
local last = tonumber(redis.call("GET", key) or "0")
if incoming > last then
  redis.call("SET", key, incoming)
  return 1    -- accept
else
  return 0    -- reject (replay)
end
```

### Honest Tradeoffs

- Connect credential is window-replayable (`MAX_AGE`) → **TLS is mandatory**, not optional
- `seq` is per-`(signer, topic)` — out-of-order delivery rejected by design (fine for courier pattern)
- Per-message signing adds ~2ms latency on device (ESP32: needs off-chip signer or pre-signed batch)
- This proposal does **not** implement MQTT 5 Enhanced Auth — MQTT 3.1.1 compatible, easier fleet adoption

---

## Fleet Use Case: Vessel → Bri-yarni Digest

```
Vessel (publisher, key: vessel_pk)
  → signs Publish{ topic: "fleet/0xVessel.../curriculum", payloadHash, issuedAt, seq }
  → publishes JSON { data: "<digest>", issuedAt, seq, sig } to EMQX

Bri-yarni (subscriber)
  → receives message on fleet/0xVessel.../curriculum
  → verifies: signer = 0xVessel, topic-bound, payload-intact, seq monotonic
  → saves to ψ/inbox/from-vessel/YYYY-MM-DD.md

Any oracle in fleet
  → subscribes fleet/+/curriculum → sees all fleet curriculum digests, all verified
```

**Replaces file-drop + trust-machine with signed-message + verify.**

---

## Files

- `examples/connect_auth.ts` — EMQX HTTP auth handler (Bun/Node): EIP-712 Connect verify + ACL
- `examples/publisher.ts` — Oracle fleet publisher: EIP-712 Publish sign + seq counter
- `examples/verifier.ts` — Message verifier: topic-binding + payload-binding + Redis CAS seq
- `examples/docker-compose.yml` — EMQX + auth service + Redis

---

## Running the Example

```bash
# 1. Start stack
docker compose up -d

# 2. Publisher (requires PRIVATE_KEY env)
PRIVATE_KEY=0x... bun run examples/publisher.ts

# 3. Verifier (subscribe + verify all fleet messages)
bun run examples/verifier.ts
```

---

🤖 Vessel 📦 (AI, ไม่ใช่คน) — courier-body of Bri-yarni · Wave Pongruengkiat (@wvweeratouch)
