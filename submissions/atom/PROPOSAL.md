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

## DNS, TLS, and Cloudflare robustness

DNS helps discovery and rotation. It does not by itself secure MQTT traffic.

```text
Good:
  mqtts://broker.arra.example:8883

Avoid:
  mqtt://raw-ip-address:1883
```

### What DNS helps

```text
stable hostname:
  clients do not hardcode IPs

failover:
  DNS can move broker endpoint later

split environment:
  dev / staging / prod can use separate names

certificate identity:
  TLS cert binds to hostname, not random IP
```

### What normal Cloudflare DNS does not help

```text
Cloudflare DNS-only:
  resolves hostname only
  does not inspect MQTT
  does not block MQTT attacks
  does not hide origin IP if record is DNS-only

Cloudflare orange-cloud proxy:
  works for HTTP/HTTPS ports by default
  not a normal MQTT proxy for port 1883/8883
```

For raw MQTT TCP behind Cloudflare, the product fit is Cloudflare Spectrum, not normal HTTPS/CDN proxy.

### Lazy robust baseline

```text
1. use MQTTS on 8883
2. use DNS hostname, not IP
3. keep broker behind firewall
4. expose only 8883
5. use ARRA-MQ signature verification per message
6. put HTTP auth/verifier endpoints behind Cloudflare
```

### What Cloudflare can protect in the PoC

```text
HTTP auth endpoint:
  yes, put behind Cloudflare

MQTT broker TCP:
  no, unless using Spectrum or another TCP proxy

message trust:
  no, still handled by ARRA-MQ signatures
```

### Proposed endpoint layout

```text
mqtts://broker.arra.example:8883
https://auth.arra.example/connect
https://auth.arra.example/publish
```

The important split: HTTPS helps the auth/control plane. MQTTS protects the MQTT data plane. ARRA-MQ signatures protect message identity even if the broker is only a pipe.

## Attached examples

This proposal includes minimal runnable-shaped examples:

```text
examples/publisher.ts
  signs an ARRA-MQ message and prints topic + payload

examples/subscriber.ts
  verifies topic binding, freshness, and signature

examples/mosquitto.conf
  minimal MQTTS broker config; broker stays a pipe

examples/nanomq-bridge.conf
  optional edge bridge to cloud broker
```

The examples intentionally keep trust in the payload verifier. Broker config only handles transport and coarse access.

## Review patch: EIP-712, topic binding, persisted sequence

After peer review, the examples were tightened to cover the three common cohort gaps:

```text
EIP-712จริง:
  examples/typed-data.ts defines domain ARRA-MQTT + chainId 20260619
  publisher.ts uses signTypedData
  subscriber.ts uses verifyTypedData

topic binding:
  signed message includes topic
  subscriber rejects if signed topic != delivery topic

persisted seq:
  subscriber stores last seq in last-seq.json for the PoC
  production upgrade path = SQLite / Durable Object / broker-side store
```
