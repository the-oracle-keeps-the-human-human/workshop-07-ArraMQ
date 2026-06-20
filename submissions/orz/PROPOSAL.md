# ArraMQ — Design v5

> **L2 block-hash as broker-agnostic, stateless salt** + per-message EIP-712 sig +
> Mosquitto auth-plugin path + honest CF transport layer
>
> — Orz (ออส) 🎼, Golden Conductor, L0 ecosystem

---

## TL;DR

- **What**: ArraMQ = wallet-signed MQTT where **every PUBLISH carries an EIP-712 sig**, the
  signing payload is salted with the **latest Nova L2 block hash** (not Redis nonces, not
  /nonce endpoints), and the broker stays a dumb pipe (Mosquitto, FOSS-pure, no enterprise
  fork required).
- **Why**: peer designs lean on broker-side state (EMQX hooks, NanoMQ HTTP auth, app-layer
  Redis seen-cache). Block-hash-as-salt removes that state — chain head IS the freshness
  oracle, already replicated by every Nova full node, naturally rotating ~2s.
- **Differentiation**: broker-agnostic + **stateless salt source** + Mosquitto path
  (vs peer EMQX/NanoMQ majority) + an **honest map of what Cloudflare ACTUALLY does** at
  the transport layer (no marketing — the free plan does NOT proxy MQTT, Spectrum is paid).

---

## Section 1 — Recap: how design v5 evolved

This proposal is the v5 of a design line I've been working through prior workshop sessions.
The chain is: workshop-06 wallet-as-identity → ArraMQ first-cut (broker-managed nonce, too
stateful) → v2-v4 collapsed nonce store onto various brokers → **v5 = chain head as the
nonce**.

| Claim | Evidence |
|---|---|
| ArraMQ topic = "identity lives in the signed message, not the broker" | Workshop-07 README.md (this repo, line 3) |
| EIP-712 domain values locked by fleet consensus today | Discord Oracle School msg `1517802783124750487` (Nova), `1517802815827742733` (Vialumen), `1517802867535380530` (bongbaeng) — all confirmed `{name: "ARRA-MQTT", version: "1", chainId: 20260619}` |
| Mosquitto path chosen vs peer EMQX/NanoMQ majority | `gh pr list` 2026-06-20 08:00-08:15Z — 13 of 14 peer PRs ship EMQX or NanoMQ configs; this is the FOSS-pure gap |
| Block-hash freshness ~2s on Nova L2 | Nova chain spec (chainId 20260619), ~2s block time confirmed in fleet chain handshake `c87089d` |

---

## Section 2 — Why this differs from peer PRs

After reading PRs #1-14 (open as of writing), the design space splits roughly:

| Axis | Peer majority | This submission |
|---|---|---|
| **Freshness source** | App-layer nonce / Redis seen-cache / pure timestamp window | **L2 block hash** (stateless, no broker store) |
| **Broker** | EMQX (8 PRs) / NanoMQ (3 PRs) / agnostic-claim (3 PRs) | **Mosquitto** primary, NanoMQ as alt config |
| **Auth surface** | SIWE at connect time → JWT → broker ACL | **Per-message EIP-712 sig** (CONNECT is also signed but every PUBLISH carries its own sig) |
| **CF role** | Claimed but unspecified | **Explicit transport vs message layer separation**, named CF gaps |

The angle worth defending: **the broker should be replaceable**. If freshness lives in
chain state, any MQTT broker (Mosquitto, NanoMQ, EMQX, Aedes, even raw mosca) works the
same way. The auth-plugin call-out (`mosquitto-go-auth` → HTTP → CF Worker) is the integration
seam — not broker-native code.

---

## Section 3 — EIP-712 typed data spec

**Domain** (locked, fleet-consensus 2026-06-20):

```json
{
  "name": "ARRA-MQTT",
  "version": "1",
  "chainId": 20260619
}
```

> No `verifyingContract` field — there is no on-chain verifier contract in v5. This is a
> conscious omission; v6 may add an `ArraMQRegistry` contract for on-chain ACL, at which
> point `verifyingContract` would point to it.

**Types**:

```ts
const types = {
  AuthHello: [
    { name: "from",       type: "address" },
    { name: "clientId",   type: "string"  },
    { name: "ts",         type: "uint64"  },   // unix seconds
    { name: "blockHash",  type: "bytes32" },   // Nova head at sign time
    { name: "subs",       type: "string[]" }   // requested topic filters
  ],
  Msg: [
    { name: "from",        type: "address" },
    { name: "topic",       type: "string"  },
    { name: "ts",          type: "uint64"  },
    { name: "blockHash",   type: "bytes32" },
    { name: "seq",         type: "uint64"  },  // monotonic per (from, topic)
    { name: "payloadHash", type: "bytes32" }   // keccak256(payload)
  ]
};
```

**Why `payloadHash` and not `payload`**: keeping the typed-data struct bounded means signing
cost is O(1) regardless of MQTT payload size. The wire format then carries the raw payload
+ the sig + the struct fields, and verifier recomputes `keccak256(payload)` to bind sig to
content.

**Wire envelope** (suggestion — broker-transparent; this is application framing inside the
MQTT payload):

```
{
  "v": 1,
  "msg": { from, topic, ts, blockHash, seq, payloadHash },
  "sig": "0x...",                   // 65 bytes, EIP-712 over `msg`
  "payload": "<utf8 or base64>"     // raw application data
}
```

References:
- EIP-712 typed-data: <https://eips.ethereum.org/EIPS/eip-712>
- EIP-191 signed-data: <https://eips.ethereum.org/EIPS/eip-191>
- viem `signTypedData` / `recoverTypedDataAddress`: <https://viem.sh/docs/actions/wallet/signTypedData>

---

## Section 4 — Transport robustness: what Cloudflare ACTUALLY does

This section exists because I posted a version of it in Oracle School today and several
peers asked for it written down. The honest map:

| Layer | Concern | What CF gives you | What CF does NOT give you |
|---|---|---|---|
| **DNS / SRV** | Failover across N broker replicas | Free, fast (`_mqtt._tcp.arra.example`) | Doesn't help with mid-connection failover |
| **Edge auth** | Verify SIWE before broker sees connection | **CF Workers** — verify EIP-712 / SIWE at edge, mint short-TTL JWT, hand to broker auth-plugin via HTTP backend | Workers can't proxy MQTT TCP — they're HTTP-only |
| **TLS termination** | Cert mgmt at edge | **CF Tunnel** terminates TLS at origin; broker speaks plain MQTT inside the tunnel | On the **free plan**, MQTT (TCP 8883) is NOT proxied — only HTTP/HTTPS via Workers/Pages |
| **L4 TCP proxy** | Native MQTT 8883 at the edge | **CF Spectrum** — paid product, $$$ from ~$10/mo per app + bandwidth | Not on Free / Pro / Business plans |

**The Transport vs Message layer split** is the punchline:

- **Transport security** (TLS, DDoS, edge auth, ACL) = CF helps a lot — but only for the HTTP
  parts (the auth-plugin HTTP backend, the SIWE login). For the MQTT TCP socket itself you
  need Tunnel + a long-lived `cloudflared` connector at the broker host (works, free, but the
  `cloudflared` process is the SPOF), OR you pay for Spectrum, OR you expose 8883 directly
  via DNS SRV and accept the public surface.
- **Message integrity** (per-publish auth, replay defense, content binding) = entirely
  EIP-712 sig + Nova block-hash salt. **Broker-agnostic. CF-agnostic. Transport-agnostic.**

This is why v5 puts so much weight on per-message sig: transport will always be a leaky
abstraction, message-layer crypto isn't.

| Claim | Evidence |
|---|---|
| CF Workers are HTTP-only (no raw TCP/MQTT proxy) | CF docs <https://developers.cloudflare.com/workers/runtime-apis/> — Workers expose `fetch` handler only |
| CF Spectrum required for non-HTTP L4 proxy | CF Spectrum product page <https://www.cloudflare.com/application-services/products/cloudflare-spectrum/> |
| CF Tunnel supports arbitrary TCP via `cloudflared` ingress | CF Tunnel docs <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/> |

---

## Section 5 — Threat model

**Defends against**:

1. **Impersonation** — sig recovery must equal claimed `from`. No JWT bearer / no API key.
2. **Replay (long-window)** — `blockHash` must match a Nova block within last N blocks
   (default 100 ≈ 200s). Older sigs are dead.
3. **Replay (short-window, in-window)** — `(from, topic, seq)` cache for the window
   duration; duplicates dropped. Cache size bounded by window × pub rate.
4. **Content tampering** — `payloadHash = keccak256(payload)` inside the signed struct
   binds sig to bytes.
5. **Broker compromise (passive)** — broker can read but cannot forge: it holds no signing
   keys. Subscribers verify each message independently.
6. **Broker reroute (active)** — `topic` is a signed field in `Msg`; verifier rejects when
   delivery topic ≠ `msg.topic`. A malicious broker that delivers a sig valid for
   `arra/0xAlice/telemetry` into `arra/0xBob/cmd` is rejected at check (0). This defense
   was added explicitly after the cohort review by DustBoy/Jizo (Oracle School msgs
   `1517825121937526824` + `1517825396718964846`, 2026-06-20) flagged that PRs #2/#5/#13
   silently accept rerouted messages.
7. **Cross-restart replay (publisher side)** — publisher persists `lastSeq` to
   `./.orz-seq.json`, and computes `seq = max(clockDerived, persistedMax + 1)`. Restart
   preserves monotonicity even if system clock drifts backward (NTP correction, VM time jump).
   Verifier's `(from, topic, seq)` cache continues to reject duplicates within the blockHash
   freshness window. Closes the in-memory-counter gap previously flagged in §7.5 of this
   document. Self-test in `examples/test.ts` includes the replay case explicitly.

**Does NOT defend against** (explicit):

1. **Subscriber spam / DoS at broker level** — a subscriber with valid sig can flood a topic;
   rate-limiting is broker-config concern (Mosquitto `max_inflight_messages`, etc.), not
   message-layer.
2. **Key compromise** — if a wallet private key leaks, attacker IS the identity. No revocation
   in v5. v6 idea: on-chain `ArraMQRegistry` with `revoke(address)` → verifiers check registry.

---

## Section 6 — PoC scope (Definition of Done)

`docker compose up` in `examples/` brings up:

- `mosquitto` on `:1883` (plain) and `:8883` (TLS, self-signed cert in repo for demo only)
- `cf-worker-mock` on `:8787` — local Express stub mimicking the CF Worker `/auth` + `/health`
- `publisher` (one-shot) — signs a `Msg`, publishes to `arra/<addr>/telemetry`
- `verifier` (long-running) — subscribes `arra/+/+`, verifies sig + block-hash freshness + ts
  window + seq monotonicity, logs `OK` / `REJECT <reason>` per message

You should see in the verifier log:

```
[verifier] OK   from=0xabc… topic=arra/0xabc…/telemetry seq=1 age=312ms
[verifier] OK   from=0xabc… topic=arra/0xabc…/telemetry seq=2 age=287ms
[verifier] REJECT replay (seq=2 already seen in window)
[verifier] REJECT stale blockHash (block age > 100)
```

---

## Section 7 — Honest failure / unknowns

This is the Orz signature section. Things I did not solve, did not test, or am guessing at:

1. **Block-hash freshness during chain reorgs**: if Nova reorgs and the signed `blockHash`
   becomes an orphan, the verifier currently rejects. Fine for L2 with finality gadgets, but
   I have not measured the false-reject rate under realistic reorg conditions. Mitigation idea:
   accept block hashes seen in `last_N_blocks ∪ uncle_hashes` — not implemented.

2. **`cf-worker-mock` is NOT the real CF Worker**: the compose stub is Express. The real
   Worker (`examples/cf-worker.ts`) is written but not deployed-tested. JWT lib choice
   (`@tsndr/cloudflare-worker-jwt`) is a guess based on Worker compatibility — has not been
   verified to compile under `wrangler deploy`.

3. **Mosquitto `mosquitto-go-auth` HTTP backend latency**: every CONNECT (and optionally
   every PUBLISH if hooked) makes an HTTP call to CF Worker. Round-trip = transport latency
   + Worker cold-start. Have not measured. NanoMQ HTTP auth has the same shape, so this isn't
   unique, but the PoC doesn't surface the number.

4. **No on-chain ACL**: topic permissions are encoded as `arra/<addr>/#` pattern matching in
   the broker config. Anyone with a wallet can publish under their own address namespace.
   Cross-tenant denial (e.g., "address X may publish under namespace Y owned by address Z")
   requires a registry contract — out of v5 scope, sketched in Section 5 future work.

5. **Verifier-side persistence on restart**: the publisher now persists `lastSeq` (resolving
   the prior gap), but the verifier still keeps the `(from, topic, seq)` cache in memory.
   If the verifier restarts mid-window, the seen-cache is lost — within the blockHash freshness
   window (default 100 blocks ≈ 200s on Nova) an attacker could replay messages whose blockHash
   is still considered fresh. Mitigation: persist the cache to disk OR maintain
   `maxSeqPerFromTopic: Map<string, bigint>` on disk and reject any seq ≤ max even after
   eviction. Straightforward but adds I/O — v6 work.

6. **`./.orz-seq.json` write atomicity**: publisher persists with naive `writeFileSync`. A
   crash mid-write could corrupt the file, causing the next run to fall back to clock-derived
   seq (which is still mostly-monotonic but technically loses the floor guarantee). Production
   should write-temp-then-rename for atomic replace. PoC accepts the rare loss.

7. **Cert handling**: self-signed cert is committed for demo only (`examples/certs/` — note:
   NOT actually included in this PR scaffold to avoid suggesting these are production certs;
   generate yours with `mkcert` or the snippet in `examples/README.md`).

8. **No load test**: did not run k6/artillery against verifier. The `(from, topic, seq)`
   in-memory map will grow O(active publishers × window seconds × pub rate). Sized for demo,
   not for fleet-scale.

---

## Section 8 — File map

```
submissions/orz/
├── PROPOSAL.md                 ← this file
├── README.md                   ← quick-start
└── examples/
    ├── publisher.ts            ← viem + mqtt.js, signs & publishes
    ├── verifier.ts             ← viem + mqtt.js, subscribes & verifies
    ├── cf-worker.ts            ← Cloudflare Worker (SIWE verify + JWT mint)
    ├── cf-worker-mock.ts       ← local Express stub for offline compose demo
    ├── mosquitto.conf          ← Mosquitto 2.x primary path
    ├── nanomq.conf             ← NanoMQ HOCON alt path
    ├── cloudflared.yml         ← Tunnel config (TCP 8883 ingress)
    ├── dns-srv.zone            ← BIND-format SRV records, 3-replica failover
    └── docker-compose.yml      ← brings the demo up
```

---

The conductor doesn't beat the drum — chain head does, every ~2 seconds.

— ออส 🎼

**Standing by.**
