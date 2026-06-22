/**
 * ArraMQ — EMQX HTTP Auth Handler
 * Vessel proposal: Oracle Fleet Message Bus
 *
 * EMQX calls POST /auth with { username, password } on every MQTT connect.
 * username = ETH address
 * password = EIP-712 signature of Connect struct
 *
 * Run: bun run connect_auth.ts
 * Requires: bun, viem
 */

import { createPublicClient, http, recoverTypedDataAddress, getAddress } from "viem";
import { mainnet } from "viem/chains";

const MAX_AGE_MS = 300_000; // 5 minutes

const DOMAIN = {
  name: "ARRA-MQTT",
  version: "1",
  chainId: 20260619,
} as const;

const CONNECT_TYPES = {
  Connect: [
    { name: "address", type: "address" },
    { name: "issuedAt", type: "uint256" },
  ],
} as const;

interface EmqxAuthRequest {
  username: string; // ETH address
  password: string; // EIP-712 sig hex
  clientid?: string;
}

interface EmqxAuthResponse {
  result: "allow" | "deny" | "ignore";
  is_superuser?: boolean;
  acl?: Array<{ permission: "allow" | "deny"; action: "publish" | "subscribe" | "all"; topic: string }>;
}

async function verifyConnect(req: EmqxAuthRequest): Promise<EmqxAuthResponse> {
  try {
    const address = getAddress(req.username); // validates checksum
    const sig = req.password as `0x${string}`;

    // Recover signer — we need to try issuedAt values... but we don't know it.
    // Client must send issuedAt in the payload. Convention: password = JSON.stringify({sig, issuedAt})
    let issuedAt: bigint;
    let signature: `0x${string}`;

    try {
      const parsed = JSON.parse(sig);
      issuedAt = BigInt(parsed.issuedAt);
      signature = parsed.sig;
    } catch {
      // Fallback: treat password as plain sig, issuedAt = now (less precise)
      return { result: "deny" };
    }

    const signer = await recoverTypedDataAddress({
      domain: DOMAIN,
      types: CONNECT_TYPES,
      primaryType: "Connect",
      message: { address, issuedAt },
      signature,
    });

    if (getAddress(signer) !== address) {
      return { result: "deny" };
    }

    const age = Date.now() - Number(issuedAt);
    if (age < 0 || age > MAX_AGE_MS) {
      console.log(`[auth] stale connect from ${address}, age=${age}ms`);
      return { result: "deny" };
    }

    console.log(`[auth] allow ${address}`);
    return {
      result: "allow",
      is_superuser: false,
      acl: [
        // Oracle may publish only to its own fleet prefix
        { permission: "allow", action: "publish",   topic: `fleet/${address}/#` },
        // Oracle may subscribe to any fleet topic
        { permission: "allow", action: "subscribe", topic: "fleet/+/#" },
        { permission: "allow", action: "subscribe", topic: "fleet/#" },
        // Deny everything else
        { permission: "deny",  action: "all",       topic: "#" },
      ],
    };
  } catch (err) {
    console.error("[auth] error:", err);
    return { result: "deny" };
  }
}

// Minimal HTTP server (Bun)
const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/auth") {
      return new Response("not found", { status: 404 });
    }
    const body: EmqxAuthRequest = await req.json();
    const result = await verifyConnect(body);
    return Response.json(result);
  },
});

console.log(`[auth] listening on :${server.port}`);
