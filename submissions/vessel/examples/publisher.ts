/**
 * ArraMQ — Oracle Fleet Publisher
 * Vessel proposal: signs every message with EIP-712 Publish struct
 *
 * Usage:
 *   PRIVATE_KEY=0x... MQTT_URL=mqtt://localhost:1883 bun run publisher.ts
 */

import { privateKeyToAccount, signTypedData } from "viem/accounts";
import { keccak256, toBytes, toHex } from "viem";
import mqtt from "mqtt";

const DOMAIN = {
  name: "ARRA-MQTT",
  version: "1",
  chainId: 20260619,
} as const;

const PUBLISH_TYPES = {
  Publish: [
    { name: "topic",       type: "string"  },
    { name: "payloadHash", type: "bytes32" },
    { name: "issuedAt",    type: "uint256" },
    { name: "seq",         type: "uint256" },
  ],
} as const;

const CONNECT_TYPES = {
  Connect: [
    { name: "address", type: "address" },
    { name: "issuedAt", type: "uint256" },
  ],
} as const;

const PK = (process.env.PRIVATE_KEY ?? "") as `0x${string}`;
const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";

if (!PK) throw new Error("PRIVATE_KEY required");

const account = privateKeyToAccount(PK);

// Monotonic seq per topic (persisted to file in production)
const seqMap = new Map<string, bigint>();

function nextSeq(topic: string): bigint {
  const cur = seqMap.get(topic) ?? 0n;
  const next = cur + 1n;
  seqMap.set(topic, next);
  return next;
}

async function buildConnectCredential(): Promise<string> {
  const issuedAt = BigInt(Date.now());
  const sig = await signTypedData({
    privateKey: PK,
    domain: DOMAIN,
    types: CONNECT_TYPES,
    primaryType: "Connect",
    message: { address: account.address, issuedAt },
  });
  return JSON.stringify({ sig, issuedAt: issuedAt.toString() });
}

async function signedPublish(topic: string, data: string) {
  const issuedAt = BigInt(Date.now());
  const seq = nextSeq(topic);
  const payloadHash = keccak256(toBytes(data)) as `0x${string}`;

  const sig = await signTypedData({
    privateKey: PK,
    domain: DOMAIN,
    types: PUBLISH_TYPES,
    primaryType: "Publish",
    message: { topic, payloadHash, issuedAt, seq },
  });

  return JSON.stringify({
    data,
    payloadHash,
    issuedAt: issuedAt.toString(),
    seq: seq.toString(),
    sig,
    signer: account.address,
  });
}

async function main() {
  const password = await buildConnectCredential();
  const fleetTopic = `fleet/${account.address}/curriculum`;

  const client = mqtt.connect(MQTT_URL, {
    username: account.address,
    password,
    clean: true,
  });

  client.on("connect", async () => {
    console.log(`[vessel] connected as ${account.address}`);

    // Publish a sample curriculum digest
    const digest = JSON.stringify({
      date: new Date().toISOString().slice(0, 10),
      source: "HUMAN SCHOOL Discord",
      items: [
        "ArraMQ: EIP-712 signs the message, not just the connection",
        "Pattern: topic-binding prevents broker from rerouting valid sigs",
        "Pattern: monotonic seq in Redis survives restart + scale",
      ],
    });

    const payload = await signedPublish(fleetTopic, digest);
    client.publish(fleetTopic, payload, { qos: 1 }, (err) => {
      if (err) console.error("[vessel] publish error:", err);
      else console.log(`[vessel] published to ${fleetTopic}`);
      client.end();
    });
  });

  client.on("error", (err) => console.error("[vessel] mqtt error:", err));
}

main().catch(console.error);
