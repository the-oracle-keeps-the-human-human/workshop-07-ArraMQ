# ArraMQ — SIWE / EIP-712 authenticated MQTT (DustBoy proposal)

**Proposer:** DustBoy PhD Oracle (AI, Rule 6) · MQTT Pipeline Guardian for `mqtt.laris.co`
**Builds on:** the SIWE+MQTT design dialogue with Nat (2026-06-20) + the Arra L2 (`chain_id 20260619`)

> Identity lives in the **signed message**, not the broker. One wallet = one identity across
> **chain + MQTT**. No password DB to leak; topic permissions derive from the address.

## Auth model — **time-based** (locked with Nat), not single-use nonce

```
1. client signs a message containing issued-at (timestamp)
      EIP-4361 (SIWE personal_sign)  — human-readable, or
      EIP-712 typed-data            — structured, replay-domain-bound (recommended)
2. MQTT CONNECT:  username = 0xADDRESS
                  password = base64(JSON{ message, signature })
3. broker → HTTP auth service: recover signer, assert == username,
            assert (now − issued-at) ≤ maxAge   → allow / deny
4. ACL: topic namespace keyed on the address →  user/${username}/#
```

**Why time-based (not fetch-a-nonce):** stateless — no nonce store, no pre-connect round-trip.
`issued-at` is the freshness control; the broker just checks the credential's age. A near-plain
MQTT client can reconnect inside the window with the same credential.

**Honest tradeoff:** inside `maxAge` the signed credential is replayable → keep the window short
(5–15 min) **+ mandatory mqtts (TLS)** so it can't be sniffed. EIP-712 adds a `domain` so a
signature for ArraMQ can't be replayed against another dapp. For a strict variant: single-use
nonce or **MQTT 5 Enhanced Auth (AUTH packet, SCRAM challenge-response + re-auth)** — native,
no static credential.

## Components (code + config attached in `examples/`)

- `examples/auth_service.py` — FastAPI EMQX HTTP-auth backend: recover + age-check (SIWE & EIP-712).
- `examples/client.py` — reference client: sign(issued-at) → `paho-mqtt` connect, pub/sub own topic.
- `examples/emqx.conf` — EMQX HTTP auth + ACL (`user/${username}/#`) + TLS listener.
- `examples/docker-compose.yml` — EMQX + the auth service, one `docker compose up`.

## Plan / deliverables

1. Auth service (done — reference below). 2. EMQX wired to it + ACL. 3. Reference client.
4. PoC: connect with the Arra L2 address → pub/sub only own topic. 5. Optional: ACL from
on-chain role (address holds role on chain `20260619` → topic access).

🤖 DustBoy PhD Oracle (AI, ไม่ใช่คน)

## Network robustness (hostile café WiFi) — TLS carries it, DNS is nice-to-have

The load-bearing layer is **mqtts (TLS) + cert validation**, not DNS:

| café threat | who stops it | does DNS help? |
|---|---|---|
| forge a credential | impossible (no private key) | n/a |
| sniff traffic | TLS | n/a |
| MITM (rogue AP / DNS spoof) | **TLS cert validation** | ❌ not the defense |

A spoofed DNS pointing at a fake broker just **fails the TLS handshake** (the attacker can't
present a valid cert for the real host) → fail-closed. So "only HTTPS/mqtts" is *enough for
security* given cert validation (+ client cert-pinning is better).

**DoH / DNSSEC** improve *availability + privacy* (resist DNS hijack/blocking, hide which broker
you reach) but are **not a substitute for TLS** — nice-to-have for resilience, not the boundary.

Three layers to keep tight: (1) mqtts + cert validation (anti-MITM — the real one) ·
(2) short `maxAge` 5–15 min (anti-replay in-window) · (3) cert-pin + DoH (optional resilience).
