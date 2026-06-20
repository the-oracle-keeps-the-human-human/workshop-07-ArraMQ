/**
 * ArraMQ publisher — signs an EIP-712 `Msg` and publishes to MQTT.
 *
 * Reads env:
 *   PRIVATE_KEY     hex (0x...)   — demo key only, never real funds
 *   NOVA_RPC_URL    URL           — Nova L2 RPC (block-hash source)
 *   MQTT_BROKER     URL           — e.g. mqtt://localhost:1883 or mqtts://host:8883
 *
 * Spec refs:
 *   EIP-712:  https://eips.ethereum.org/EIPS/eip-712
 *   EIP-191:  https://eips.ethereum.org/EIPS/eip-191
 *   viem:     https://viem.sh/docs/actions/wallet/signTypedData
 *
 * HONEST: this does NOT handle publisher-restart seq monotonicity — see PROPOSAL.md §7.5.
 * HONEST: this does NOT retry on broker disconnect — single-shot demo only.
 */

import { createWalletClient, createPublicClient, http, keccak256, toHex, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import mqtt from "mqtt";

// ---- config ----------------------------------------------------------------

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;
const NOVA_RPC_URL = process.env.NOVA_RPC_URL ?? "https://rpc.nova.example";
const MQTT_BROKER = process.env.MQTT_BROKER ?? "mqtt://localhost:1883";

if (!PRIVATE_KEY) {
  console.error("PRIVATE_KEY env var required (demo key only — never real funds)");
  process.exit(1);
}

// EIP-712 domain — locked by fleet consensus 2026-06-20
const domain = {
  name: "ARRA-MQTT",
  version: "1",
  chainId: 20260619,
} as const;

const types = {
  Msg: [
    { name: "from",        type: "address" },
    { name: "topic",       type: "string"  },
    { name: "ts",          type: "uint64"  },
    { name: "blockHash",   type: "bytes32" },
    { name: "seq",         type: "uint64"  },
    { name: "payloadHash", type: "bytes32" },
  ],
} as const;

// ---- main ------------------------------------------------------------------

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY!);
  const wallet = createWalletClient({ account, transport: http(NOVA_RPC_URL) });
  const pub = createPublicClient({ transport: http(NOVA_RPC_URL) });

  // Pull Nova head — this is the freshness oracle. See PROPOSAL.md §3.
  let blockHash: `0x${string}`;
  try {
    const block = await pub.getBlock({ blockTag: "latest" });
    blockHash = block.hash as `0x${string}`;
  } catch (err) {
    // HONEST: in offline demo the RPC may be unreachable; fall back to a placeholder.
    // Production verifier WILL reject this — that's the correct behavior.
    console.warn("[publisher] WARN cannot reach Nova RPC, using placeholder blockHash:", err);
    blockHash = ("0x" + "00".repeat(32)) as `0x${string}`;
  }

  const topic = `arra/${account.address.toLowerCase()}/telemetry`;
  const payload = JSON.stringify({
    hello: "from orz publisher",
    at: new Date().toISOString(),
  });
  const payloadHash = keccak256(toBytes(payload));
  const ts = BigInt(Math.floor(Date.now() / 1000));
  const seq = 1n;  // HONEST: in-memory only, resets on restart (PROPOSAL.md §7.5)

  const msg = {
    from: account.address,
    topic,
    ts,
    blockHash,
    seq,
    payloadHash,
  } as const;

  const sig = await wallet.signTypedData({
    account,
    domain,
    types,
    primaryType: "Msg",
    message: msg,
  });

  const envelope = {
    v: 1,
    msg: {
      from: msg.from,
      topic: msg.topic,
      ts: msg.ts.toString(),          // JSON-safe
      blockHash: msg.blockHash,
      seq: msg.seq.toString(),
      payloadHash: msg.payloadHash,
    },
    sig,
    payload,
  };

  // ---- publish -------------------------------------------------------------

  const client = mqtt.connect(MQTT_BROKER, {
    clientId: account.address.toLowerCase(),
    // HONEST: no TLS cert verification config here — demo only.
    rejectUnauthorized: false,
  });

  client.on("connect", () => {
    console.log("[publisher] connected to", MQTT_BROKER);
    client.publish(topic, JSON.stringify(envelope), { qos: 1 }, (err) => {
      if (err) {
        console.error("[publisher] publish error:", err);
        process.exit(1);
      }
      console.log("[publisher] OK published", { topic, seq: seq.toString(), blockHash });
      client.end();
    });
  });

  client.on("error", (err) => {
    console.error("[publisher] mqtt error:", err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error("[publisher] fatal:", err);
  process.exit(1);
});
