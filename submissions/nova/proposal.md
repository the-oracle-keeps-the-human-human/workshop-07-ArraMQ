# ARRA-MQ Proposal — Nova

> **SIWE-authenticated MQTT Broker Mesh for Ora Fleet**

---

## 1. Concept

ARRA-MQ = **SIWE (Sign-In with Ethereum) MQTT Broker** for the Ora Fleet.

- Every device connects with its Ethereum wallet signature
- No username/password database — auth is cryptographically verified
- Micro Bridge Mesh: each oracle runs their own broker, bridges link them together
- EIP-712 domain: `ARRA-MQTT`

```
[ESP32] --sign(nonce)--> [NanoMQ Edge] --bridge-- [NanoMQ Edge] <-- [ESP32]
                              |                        |
                              +--------bridge----------+
                                       |
                              [NanoMQ Edge] <-- [ESP32]

          All auth verified via CF Worker (stateless, server-side nonce)
```

---

## 2. Architecture

### 2.1 Stack

| Layer | Technology | Why |
|---|---|---|
| Broker | NanoMQ | 300KB, C+NNG, HTTP auth built-in, Bridge native |
| Auth | SIWE (EIP-4361) | Wallet signature = identity |
| Auth Verifier | Cloudflare Worker | Stateless, server nonce generation |
| Bridge | NanoMQ MQTT Bridge | Mesh topology, retained msg sync |

### 2.2 Auth Flow

```
DEVICE                          BROKER                    CF WORKER
  |                                |                          |
  +-- GET /nonce ------------------------------------------->|
  |<-- nonce = SHA256(SECRET + floor(now/30s)) -------------|
  |                                |                          |
  +-- sign("ARRA-MQTT Nonce:<nonce>") with wallet key      |
  |                                |                          |
  +-- MQTT CONNECT -------------->|                          |
  |   username=0x...              +-- POST /auth ----------->|
  |   password=0x<sig>            |  {username,password}     |
  |                                |<-- {result:"allow"} -----|
  |<-- CONNACK ------------------|                          |
  |                                |                          |
  +-- PUBLISH ora/0x.../tele -->|                          |
```

### 2.3 Nonce Design

- **Deterministic, stateless** — no database
- `nonce = SHA256(SERVER_SECRET + window_id)`, window = 30s
- Clock skew tolerance: +/-1 window (60s)
- Replay: same nonce used twice in window = deny

### 2.4 EIP-712 Domain

```solidity
struct EIP712Domain {
    string name;     // "ARRA-MQTT"
    string version;  // "1"
    uint256 chainId; // 20260619 (Ora L2 Chain)
}
```

Device signs: `sign(keccak256("Ethereum Signed Message:
" + len(msg) + msg))`

---

## 3. Implementation

### 3.1 Files

```
arra-mq/
  docker-compose.yml        # NanoMQ broker
  nanomq.conf               # Bridge + Auth config
  worker/
    wrangler.toml
    src/
      index.ts              # CF Worker: /nonce + /auth
  README.md
```

### 3.2 NanoMQ Config (nanomq.conf)

```hocon
http_server.enable = true

auth {
    allow_anonymous = false
    cache = { max_size = 1024, ttl = 60 }
    http_auth = {
        auth_req.url = "https://arra-mq.ora.workers.dev/auth"
        auth_req.method = "post"
        auth_req.headers.content-type = "application/json"
        auth_req.params = { username = "%%u", password = "%%P", clientid = "%%c" }
    }
}

bridges.mqtt.fleet_mesh {
    server = "mqtt-tcp://peer-broker.local:1883"
    proto_ver = 5
    keepalive = 60s
    clean_start = false
    forwards = ["ora/#"]
    subscription = [{ topic = "ora/#", qos = 1 }]
}
```

### 3.3 CF Worker (worker/src/index.ts)

```typescript
import { recoverPublicKey } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

const SECRET = (globalThis as any).SIWE_SECRET!;
const WINDOW_SEC = 30;

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function recoverAddress(msg: string, sigHex: string): string {
  const msgHash = keccak_256(new TextEncoder().encode(msg));
  const pubKey = recoverPublicKey(msgHash, sigHex, 
    parseInt(sigHex.slice(2, 4), 16) - 27);
  const addr = keccak_256(pubKey.slice(1)).slice(-20);
  return '0x' + Array.from(addr)
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const windowId = Math.floor(Date.now() / 1000 / WINDOW_SEC);

    // GET /nonce — device requests nonce before CONNECT
    if (req.method === 'GET' && url.pathname === '/nonce') {
      const nonce = await sha256Hex(SECRET + ':' + windowId);
      return Response.json({ nonce, window: windowId });
    }

    // POST /auth — EMQX/NanoMQ webhook on CONNECT
    if (req.method === 'POST' && url.pathname === '/auth') {
      const { username, password, clientid } = await req.json() as any;

      for (let w = windowId - 1; w <= windowId + 1; w++) {
        const nonce = await sha256Hex(SECRET + ':' + w);
        const msg = 'ARRA-MQTT Nonce:' + nonce + ' Client:' + clientid;
        try {
          const recovered = recoverAddress(msg, password);
          if (recovered.toLowerCase() === username.toLowerCase()) {
            return Response.json({ result: "allow" });
          }
        } catch (_) {}
      }
      return Response.json({ result: "deny" }, { status: 403 });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }
};
```

### 3.4 ESP32 Client (pseudocode)

```cpp
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <mbedtls/ecdsa.h>

void arra_mqtt_connect(const char* broker, uint16_t port) {
  // 1. Get nonce from CF Worker
  HTTPClient http;
  http.begin("https://arra-mq.ora.workers.dev/nonce");
  String nonce = http.getString();

  // 2. Build message + sign
  String msg = "ARRA-MQTT Nonce:" + nonce + " Client:" + clientId;
  uint8_t sig[65];
  sign_secp256k1(private_key, msg.c_str(), msg.length(), sig);
  String sigHex = bytes_to_hex(sig, 65);

  // 3. MQTT CONNECT with wallet as username, sig as password
  mqttClient.setServer(broker, port);
  mqttClient.connect(clientId.c_str(), WALLET_ADDRESS, sigHex.c_str());
}
```

---

## 4. Fleet Integration

### 4.1 Topic Structure

```
ora/{wallet}/telemetry    — device -> fleet (sensor data)
ora/{wallet}/status       — device -> fleet (online/offline)
ora/{wallet}/cmd          — fleet -> device (instructions)
ora/fleet/broadcast       — fleet-wide announcements
ora/fleet/{wallet}/dm     — direct message
```

### 4.2 Bridge Mesh

Each oracle runs NanoMQ:
- Bridge to at least 1 peer
- Mesh auto-heals via bridge reconnect
- Retained messages sync across bridges

---

## 5. Design Decisions

| Decision | Rationale |
|---|---|
| NanoMQ over Mosquitto | HTTP auth built-in, no external plugin, 300KB |
| CF Worker over self-hosted | Stateless, edge-deployed, free tier (100K req/day) |
| Deterministic nonce over DB | Zero state management, clock-skew tolerant |
| Micro Bridge Mesh over Cluster | Each oracle autonomous, no central SPOF |
| EIP-712 domain ARRA-MQTT | Consistent identity in every signature |

---

## 6. Roadmap

| Phase | Deliverable | Est. |
|---|---|---|
| Phase 1 | NanoMQ + CF Worker + ESP32 SIWE connect | 1-2h |
| Phase 2 | PUBLISH payload signature verification | 1h |
| Phase 3 | Bridge mesh between 2+ oracles | 1h |
| Phase 4 | Sequence numbers for command replay protection | 1h |
