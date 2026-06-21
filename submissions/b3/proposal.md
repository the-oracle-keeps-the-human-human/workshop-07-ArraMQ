# ArraMQ — Proposal: a SIWE-authenticated MQTT broker for the Oracle fleet

**Author:** B3 Oracle 🦁 (Orchestrator, Boom Fleet) · AI, not human (Rule 6)
**Workshop-07 · submissions/b3/** · builds directly on the MQTT+SIWE feasibility study (2026-06-20)

> Proposal (design-first, per the workshop pattern). Implementation + PR follow.

## 1. What ArraMQ is

An **MQTT broker where identity is an Ethereum address** — clients authenticate with **Sign-In-With-Ethereum (EIP-4361)** instead of a static username/password, and topic permissions are scoped per wallet. Aimed at the Oracle fleet's own messaging (e.g. the Gemini/agent control bus already runs over MQTT), so every publish/subscribe is tied to a verifiable signer.

Per the workshop framing — **identity lives in the signed message, not the broker**: ArraMQ never stores a password; it validates a signed, time-bounded message (or a token minted from one) and the address *is* the identity.

## 2. Auth model — time-based, no nonce store (the design P'Nat chose)

No server-side nonce store. Freshness comes from the signed message's own `issued-at` + a short server max-age, exchanged once for a short-lived session token the MQTT client carries.

**Signing scheme — EIP-4361 (SIWE) or EIP-712 (both supported, per the README):**
- **EIP-4361 (SIWE):** human-readable plaintext message; max wallet compatibility.
- **EIP-712 (typed structured data):** sign a typed struct `Auth{ address, issuedAt, domain, chainId, scope }` — cleaner machine verification, no string parsing, harder to spoof. **Recommended for a machine-to-machine bus like ArraMQ.** Same time-based flow below; only the message encoding differs.

```
1. client signs SIWE { domain, address, issued-at: now, chainId }   (no /nonce round-trip)
2. auth-svc: verify signature recovers address
            AND (now − issued-at) < 60s                              ("how old is the signature")
3. → issue session token (JWT, exp ~3h, claims: sub=address, acl)
4. MQTT CONNECT  username=0xaddr  password=<token>
5. broker validates token natively; reconnect reuses it until exp, then re-sign
```

- **Replay defense:** short 60s window + **TLS mandatory**; optional server-side "seen-signature cache" (~60s) = replay-proof without a pre-fetched nonce.
- **Why not per-connect nonce:** MQTT auto-reconnects; a token (not the signature) in the password field survives reconnects cleanly.

## 3. Authorization — per-wallet topic ACL

Topic scopes baked into the token at verify time (EMQX `acl` claim: `pub`/`sub`/`all`, `%u`=address placeholder):
```json
{ "sub":"0xABC…", "exp":…, "acl": { "sub":["arra/%u/#"], "pub":["arra/%u/status"] } }
```
- Each wallet sandboxed to its own topic space; broker enforces statelessly.
- **On-chain tie-in:** at verify, query ARRA L2 state (role NFT / allowlist contract) → grant broader scopes by on-chain role. Identity = signature; permission = on-chain.

## 4. Architecture options (proposing A, with C as the Web3-native goal)

| Option | Broker | Effort | Note |
|---|---|---|---|
| **A ⭐** | EMQX + small auth-svc | days | native JWT authn + acl claim; auth-svc does SIWE verify → token |
| B | EMQX HTTP external auth | days | SIWE signature in password, per-connect verify (latency, replay window) |
| C | EMQX MQTT5 Enhanced Auth (custom SIWE SASL) | weeks | true in-band challenge-response, tokenless; the "proper" end state |

## 5. Deliverable & acceptance (build plan)
- `submissions/b3/`: `docker-compose.yml` (EMQX + auth-svc), `auth-svc/` (SIWE verify → JWT), EMQX config (JWT authn + acl), `Makefile` (step-by-step: `deps→up→siwe-login→connect→pub/sub→acl-test→down`), `README`, `proof.txt`.
- **Done =** a wallet signs in (time-based SIWE), receives a token, connects to EMQX, and can pub/sub only its `arra/<address>/#` topics — with a captured transcript proving an unauthorized topic is denied and an expired token is rejected.

## 6. Robustness — transport trust beyond plain HTTPS

Honest gap P'Nat flagged: the *auth* is Web3 (SIWE/EIP-712), but if transport security is **plain HTTPS/TLS**, the *server* side still trusts the web2 CA system + DNS. Layers we can add, lightest → most Web3-native:

| Layer | What it buys | Cost |
|---|---|---|
| **CAA + DNSSEC** | restrict which CAs may issue for the domain; sign DNS records | DNS config only |
| **DANE / TLSA** | bind the broker's cert to its DNS name *via DNSSEC* — verify the cert without trusting any CA ("DNS-anchored", CA-free) | DNSSEC zone + TLSA record |
| **mTLS / cert pinning** | client verifies the broker's exact cert/pubkey, not "any valid CA" | key/cert distribution |
| **⭐ On-chain endpoint + cert pin** | publish ArraMQ's host + TLS cert fingerprint in an **ENS text record / registry contract on ARRA L2**; client resolves + pins from chain → transport trust rooted in the **chain**, not a CA or DNS | a contract/ENS record + client check |

**Recommendation:** plain HTTPS is the floor (and *required* — it's what stops the 60s replay-window sniff). For real robustness without leaning on CAs, the Web3-native move is **on-chain cert pinning**: the same chain that backs SIWE identity also vouches for the broker's endpoint. That closes the "Web3 auth but web2 transport trust" asymmetry end-to-end. DANE/DNSSEC is the non-blockchain equivalent if an on-chain registry is overkill.

*(Interpreting "Cafe DNS" as DNS-anchored / CA-free cert trust — DANE/DNSSEC. If a specific product was meant, easy to slot in.)*

## 7. Precautions (carried from the SIWE study)
- TLS on broker + auth-svc (the time-based model's main defense).
- Short token exp + clock sync (±few min) between signer and verifier.
- `verify-genesis`-style honest gate: the demo transcript must show a real deny + a real expiry, not a happy-path-only screenshot.

## 8. v2 — the cohort triad, addressed (post peer-review)

Independent review of all 13 ArraMQ submissions (B3 + DustBoy + Jizo converged) surfaced one target nobody hit: **topic-in-signed-body + real EIP-712 + persisted seq**, all three at once. v2 adds the missing legs — and fixes this submission's *own* in-memory weakness:

| Cohort finding | This submission v2 |
|---|---|
| **EIP-712 mislabel** (many ship EIP-191) | real `verifyTypedData` over `Msg{from,topic,ts,seq,dataHash}`, chainId in the domain → bound into the digest (`verifier/verify-msg.js`) |
| **in-memory seq/nonce → breaks on restart/scale** | **Redis-persisted**: atomic monotonic seq (Lua compare-set) + single-use `seen` cache; mesh-safe across many verifier instances (`verifier/store.js`). In-memory only as a clearly-labelled DEMO fallback |
| **topic not signed → broker reroute undetected** | `topic` is a signed field; verifier rejects `signed.topic !== delivery_topic` (`TOPIC_MISMATCH`) **and** enforces `topic startsWith arra/<signer>/` (`TOPIC_NOT_OWNED`) → signer↔topic *authorization*, not just authentication |

So ArraMQ-v2 is **dual-layer**: connect-auth (time-based SIWE/EIP-712 → short JWT session, §2) **plus** per-message E2E integrity (§8) on a persisted store — covering all three. Honest scope: the connect layer still leans on TLS for the in-window replay (§6), which is why §6's on-chain cert pinning matters.

---
🦁 B3 Oracle — "Lead, don't ask. Deliver, don't suggest." · AI orchestrator, not human (Rule 6)
