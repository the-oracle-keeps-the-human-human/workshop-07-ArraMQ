# ArraMQ — Orz submission

Wallet-signed MQTT where the **freshness oracle is the L2 chain head**.
See [`PROPOSAL.md`](./PROPOSAL.md) for the full design.

## What's inside

```
PROPOSAL.md                  Design v5 — Cite-then-claim, ~300 lines
README.md                    you are here
examples/publisher.ts        viem + mqtt.js → signs Msg, publishes to arra/<addr>/telemetry
examples/verifier.ts         viem + mqtt.js → subscribes arra/+/+, verifies sig+blockhash+ts+seq
examples/cf-worker.ts        Cloudflare Worker — POST /auth (SIWE verify + JWT), GET /health
examples/cf-worker-mock.ts   local Express stub for offline compose demo
examples/mosquitto.conf      Mosquitto 2.x — TLS :8883 + mosquitto-go-auth HTTP backend
examples/nanomq.conf         NanoMQ alt — HOCON, http_auth + bridge mesh
examples/cloudflared.yml     CF Tunnel — TCP 8883 ingress to broker origin
examples/dns-srv.zone        BIND zone — 3 SRV records for _mqtt._tcp failover
examples/docker-compose.yml  brings mosquitto + verifier + publisher + cf-worker-mock up
```

## Quick start (local demo, no Cloudflare needed)

Prereqs: Docker + Docker Compose, optionally Bun or Node 20+ for running publisher/verifier
outside the compose network.

```bash
cd submissions/orz/examples

# 1) bring up broker + worker-mock + verifier
docker compose up -d mosquitto cf-worker-mock verifier

# 2) tail verifier log
docker compose logs -f verifier

# 3) in another terminal: fire a one-shot publisher
docker compose run --rm publisher

# expected: verifier prints OK lines, then if you re-run publisher quickly
# without bumping seq, REJECT replay
```

## Running publisher/verifier directly (without compose)

```bash
bun install viem mqtt

export PRIVATE_KEY=0x...                       # demo key only — never real funds
export NOVA_RPC_URL=https://rpc.nova.example   # any Nova-compat RPC
export MQTT_BROKER=mqtt://localhost:1883       # or mqtts://localhost:8883 for TLS

bun examples/publisher.ts   # one-shot publish
bun examples/verifier.ts    # long-running subscribe + verify
```

## EIP-712 domain (locked, fleet consensus)

```json
{ "name": "ARRA-MQTT", "version": "1", "chainId": 20260619 }
```

Any peer broker/verifier using these exact domain values can interop with this submission's
signer/verifier byte-for-byte.

## Threat model + honest failures

See [`PROPOSAL.md` §5 and §7](./PROPOSAL.md). TL;DR: defends impersonation / replay /
tampering / passive broker compromise; does NOT defend key compromise or subscriber-side
DoS. Six explicit "did not test" items in §7.

— ออส 🎼  ·  **Standing by.**
