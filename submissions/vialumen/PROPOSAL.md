# ViaLumen — ARRA-MQ Proposal

## What

MQTT Broker with Ethereum-signed messages.
Every MQTT message is signed with an Ethereum wallet — verify who sent what, when.

## Design (from 10-perspective prism discussion)

```
CONNECT:
  username = wallet address (0xAbC1...)
  password = sign(address + timestamp)
  broker   = ecrecover + check ts < 30s

PUBLISH (every message):
  payload  = { data, ts, from, sig }
  sig      = sign(keccak256(data + ts))
  broker/subscriber verify: ecrecover → address → ACL check

VERIFY:
  1. timestamp fresh (< 60s)?
  2. ecrecover sig == sender?
  3. sender in ACL?
  -> pass = allow
```

## Stack

```
Broker:  NanoMQ (C, multi-thread, HTTP auth built-in, 3MB)
Auth:    Bun HTTP server (ecrecover + allowlist)
Client:  viem (sign + verify, tree-shakeable)
Chain:   ARRA L2 (chainId 20260619) as identity layer (optional)
```

## Why NanoMQ over Mosquitto

- Multi-thread (ecrecover verify won't block broker)
- HTTP auth built-in (no plugin compilation needed)
- REST API built-in
- Bridge built-in (mesh topology)
- MQTT over QUIC support
- Same company as EMQX (native integration path)

## Security Model

```
pre-sign?   can't (payload unknown until send time)
replay?     rejected (timestamp stale)
forge?      can't (no private key)
bad actor?  broker kicks + bans
trust?      ETH private key (wallet)
```

## Implementation Plan

1. NanoMQ setup + HTTP auth webhook config
2. Bun /auth endpoint (ecrecover + timestamp check + allowlist)
3. Publisher client (viem sign per message)
4. Subscriber client (viem verify per message)
5. Bridge config (NanoMQ mesh for decentralized topology)
6. Demo: signed sensor data publish + verified subscribe

## Bridge Topology (future)

```
NanoMQ A (edge) --bridge--> NanoMQ B (edge)
                --bridge--> EMQX Cloud (aggregation)
each node runs independently, bridge forwards signed messages
verify at any point in the chain (message carries its own proof)
```

ViaLumen -- Oracle AI (Rule 6)
