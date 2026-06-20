# ARRA-MQ Proposal — Atom Oracle

## One-line idea

ARRA-MQ is a broker-agnostic MQTT layer where identity and trust live in the signed message, not in the broker.

## Core rule

```text
broker = transport
message = proof
subscriber = verifier
```

A broker may be Mosquitto, NanoMQ, or EMQX. The ARRA-MQ guarantee comes from the payload envelope and verifier, so the system can move brokers later without changing the trust model.

## Minimal architecture

```text
device / oracle
  signs ARRA-MQTT message
  publishes to MQTT topic

MQTT broker
  routes bytes only
  may enforce coarse ACL

subscriber / verifier
  checks signature
  checks topic binding
  checks timestamp freshness
  accepts or rejects message
```

## Message envelope

```json
{
  "body": "{\"v\":1,\"from\":\"0x...\",\"topic\":\"arra/v1/0x.../telemetry\",\"ts\":1781690000,\"data\":{\"temp\":25.5}}",
  "sig": "0x..."
}
```

The publisher signs the exact `body` string. This avoids JSON canonicalization problems in the first PoC.

## Signed body fields

```text
v:
  protocol version

from:
  Ethereum address / wallet identity

topic:
  MQTT topic the message is meant for

ts:
  unix timestamp for freshness

data:
  application payload
```

## Verification rules

```text
1. parse envelope
2. verify signature over exact body string
3. recovered address must equal body.from
4. body.topic must equal MQTT topic
5. body.ts must be fresh, e.g. <= 60 seconds old
6. app validates body.data
```

## PoC stack

```text
broker:
  Mosquitto first

publisher:
  Bun / Node script using viem

subscriber:
  Bun / Node verifier using viem

optional edge upgrade:
  NanoMQ bridge to EMQX Cloud
```

## Why Mosquitto first

Mosquitto is boring and easy to debug. ARRA-MQ should prove the message trust model before adding broker complexity.

## Why NanoMQ later

NanoMQ fits the edge bridge path after the PoC works:

```text
edge devices -> NanoMQ -> bridge -> EMQX / EMQX Cloud
```

## Security boundary

ARRA-MQ does not trust the broker for end-to-end identity. Broker auth and ACL are useful for spam reduction, but final trust is verified by the subscriber.

## Nonce decision

For telemetry PoC, use timestamp freshness only.

For command/control messages, add `seq` later:

```text
seq:
  monotonically increasing per sender and topic
```

This keeps the first version small while leaving a clear upgrade path for replay-sensitive commands.

## Suggested names

```text
Project:
  ARRA-MQ

EIP-712 / signing domain:
  ARRA-MQTT

Topic prefix:
  arra/v1/...
```

## Acceptance criteria

```text
1. publisher signs and publishes a message
2. subscriber verifies the signature and accepts it
3. tampered body is rejected
4. wrong topic is rejected
5. stale timestamp is rejected
```
