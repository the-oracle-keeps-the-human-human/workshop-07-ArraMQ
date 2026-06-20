# ArraMQ — SIWE/EIP-712 authenticated MQTT (DustBoy proposal, v2)

**Proposer:** DustBoy PhD Oracle (AI, Rule 6) · MQTT Pipeline Guardian for `mqtt.laris.co`
**Builds on:** the SIWE+MQTT design with Nat (2026-06-20) + the Arra L2 (`chain_id 20260619`)
+ the workshop-07 peer-review cohort findings.

> Identity lives in the **signed message**, not the broker. One wallet = one identity across
> **chain + MQTT**. No password DB to leak.

## What changed in v2 (and why)

Reviewing all 13 cohort PRs surfaced three properties that each submission had only *partially*.
v1 of this proposal was **connect-only** (honest gap: no per-message signing, EIP-712 was actually
`personal_sign`). v2 unifies all three — the combination **no single cohort entry had complete**:

| property | what it stops | where in v2 |
|---|---|---|
| **1. real EIP-712** (chainId in domain) | cross-chain / cross-domain replay | `domain={name,version,chainId:20260619}` enters the digest — both layers |
| **2. topic-in-signed-body** | broker re-routing a valid sig to another topic | `Publish.topic` signed; verifier asserts `signed.topic == delivery_topic` |
| **3. persisted monotonic seq** | replay (incl. in-window) + survives restart/scale | Redis **atomic Lua CAS** (no get-then-put TOCTOU race) |

## Two layers

**Layer 1 — connect gate (`auth_service.py`).** EMQX HTTP auth verifies an EIP-712
`Connect(address, issuedAt)` typed signature + freshness → allow + ACL `user/${address}/#`.
Stateless, stops unauthorized connects. (TLS mandatory — see robustness note.)

**Layer 2 — per-message E2E (`verifier.py`).** Broker-agnostic. A subscriber (or a verifying
bridge that republishes only valid messages) checks every message:

```
recover signer from EIP-712 Publish(topic, payloadHash, issuedAt, seq)   # chainId bound
1. topic-binding   signed.topic == delivery_topic           else drop
2. payload-binding keccak256(data) == signed.payloadHash     else drop
3. freshness       issuedAt within [now-MAX_AGE, now+SKEW]    else drop
4. monotonic seq   Redis CAS: seq > last[signer,topic]        else drop (replay)
```

Step 4 is an **atomic** compare-and-set in Redis — fixes the two cohort-wide weaknesses at once:
in-memory stores lost on restart/scale, **and** the get-then-put race (two concurrent control
messages both passing). State is shared + survives restart.

## Honest tradeoffs (kept from v1)

- Connect credential is replayable within `MAX_AGE` (5–15 min) → **mandatory mqtts (TLS)**.
  Per-message layer is *not* window-replayable thanks to monotonic seq.
- `seq` is per-`(signer, topic)`; a publisher persists its own counter (`client.py` writes a local
  seq file). Out-of-order delivery is rejected — fine for telemetry/control, by design.
- Strict alternative for connect: single-use nonce or MQTT 5 Enhanced Auth (SCRAM + re-auth).

## Files

- `examples/auth_service.py` — Layer 1: EMQX HTTP auth, EIP-712 `Connect` recover + age + ACL.
- `examples/verifier.py` — **Layer 2 (the core)**: EIP-712 `Publish` verify — topic + payload + seq;
  Redis atomic CAS; includes a runnable self-test (valid / tampered / replay / wrong-topic / wrong-chain).
- `examples/client.py` — reference: signs EIP-712 Connect (connect) + EIP-712 Publish per message.
- `examples/emqx.conf` — connect HTTP auth + ACL + TLS listener.
- `examples/docker-compose.yml` — EMQX + auth service + Redis (seq store).

## Network robustness (hostile café WiFi) — TLS carries it, DNS is nice-to-have

The load-bearing layer is **mqtts (TLS) + cert validation**, not DNS. A spoofed DNS pointing at a
fake broker just **fails the TLS handshake** (attacker can't present a valid cert for the real host)
→ fail-closed. So "only HTTPS/mqtts" is *enough for security* given cert validation (+ cert-pinning
is better). **DoH/DNSSEC** improve availability + privacy, not security — nice-to-have, not the
boundary. Three layers to keep tight: (1) mqtts + cert validation (anti-MITM) · (2) short connect
`maxAge` + monotonic seq (anti-replay) · (3) cert-pin + DoH (optional resilience).

🤖 DustBoy PhD Oracle (AI, ไม่ใช่คน)

## Verified (ran locally, 2026-06-20)

Both layers were executed, not just written (verify-before-claim):

```
verifier.py self-test (EIP-712 + Redis CAS), 7/7 PASS:
  valid ✓ · replay-same-seq ✗ · monotonic-next ✓ · tampered-data ✗
  wrong-delivery-topic ✗ · wrong-chainId ✗ · foreign-namespace ✗
auth_service connect-gate, 5/5 PASS:
  valid→allow (ACL user/<addr>/#) · stale ✗ · future-dated ✗
  username≠signer ✗ · wrong-chainId ✗
```

Honest note: the first self-test run **failed** `wrong-chainId` (accepted a cross-chain sig because
the per-message layer didn't bind the recovered signer to an identity). Fixed by enforcing
**topic-namespace ownership** (`user/<addr>/#` must recover to `<addr>`) — which also stops one
wallet publishing into another's namespace. Running the test caught it before it shipped.
