# ArraMQ — B3 Oracle 🦁

**SIWE / EIP-712 authenticated MQTT** — identity is an Ethereum address in a signed, time-bounded message; the broker stores no password. Builds on B3's MQTT+SIWE feasibility study and the **time-based design** chosen with P'Nat (no nonce store).

📄 Full design + robustness analysis: [`proposal.md`](./proposal.md)

## How it works
```
1. client signs EIP-712 Auth{ address, issuedAt, scope }   ← no /nonce round-trip
2. auth-svc: verify sig recovers address  AND  (now − issuedAt) < 60s
             (+ optional seen-signature cache = replay-proof)
3. → mint JWT (exp 3h, claims: sub=address, acl per-wallet)
4. MQTT CONNECT  username=0xaddr  password=<JWT>
5. EMQX validates JWT natively; acl claim scopes topics to arra/<address>/#
   reconnect reuses the token until exp, then re-sign
```

## What's here (runnable PoC)
| File | Role |
|------|------|
| `auth-svc/index.js` | verify EIP-712 (ethers) + time-freshness → mint JWT (per-wallet `acl` claim) |
| `emqx/emqx.conf` | EMQX 5 JWT authn (`from=password`, HS256) + deny-by-default authz |
| `client/connect.js` | sign typed data → get token → connect → sub own topic, **deny foreign topic** |
| `docker-compose.yml` | EMQX + auth-svc (NO_PROXY guard from WS-06) |
| `Makefile` | `deps → up → health → demo → acl-test → expiry-test → down` |

## Run
```bash
cd submissions/b3
make deps && make up && make health
make demo        # client log: "subscribed (own topic) ✅" + "denied foreign topic ✅ (expected)"
```

## Acceptance (honest gate — not happy-path only)
- ✅ a wallet signs in (time-based EIP-712) and connects with the minted token
- ✅ it can pub/sub **only** `arra/<its-address>/#`
- ✅ subscribing to another wallet's topic is **denied** (ACL)
- ✅ an **expired** token is rejected by EMQX on reconnect

## Robustness beyond HTTPS (P'Nat's question)
Auth is Web3 but plain HTTPS leaves *transport* trust on web2 CAs. Options, lightest→Web3-native: **CAA+DNSSEC → DANE/TLSA (CA-free, DNS-anchored) → mTLS/cert-pin → ⭐ on-chain endpoint+cert-fingerprint (ENS/registry on ARRA L2)**. The last roots transport trust in the same chain that backs identity. See `proposal.md` §6.

## Why EIP-712 (over plaintext SIWE) here
ArraMQ is a machine-to-machine bus — a typed struct (`Auth{address,issuedAt,scope}`) verifies without string parsing and is harder to spoof. EIP-4361 SIWE is supported too (per the workshop title); only the message encoding differs.

---
🦁 B3 Oracle — "Lead, don't ask. Deliver, don't suggest." · AI orchestrator, not human (Rule 6)
