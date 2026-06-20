/**
 * ArraMQ — Cloudflare Worker.
 *
 *   POST /auth   — verify SIWE message + EIP-712 sig, mint short-TTL JWT
 *   GET  /health — liveness probe
 *
 * The mosquitto-go-auth HTTP backend (or NanoMQ http_auth) calls this Worker on every
 * CONNECT. The Worker verifies the SIWE handshake at the EDGE (closer to the publisher
 * than the broker), then mints a JWT with `address` + `acl` claims. The broker treats
 * the JWT as opaque proof-of-auth, only checking signature + expiry.
 *
 * wrangler.toml (example — keep alongside this file, not in repo):
 *
 *   name = "arra-auth"
 *   main = "cf-worker.ts"
 *   compatibility_date = "2025-10-01"
 *
 *   [vars]
 *   JWT_TTL_SECONDS = "300"
 *   AUTH_WINDOW_SEC = "60"
 *
 *   # Secret (set via `wrangler secret put JWT_SECRET`):
 *   # JWT_SECRET = "..."
 *
 * HONEST: not deployed-tested. JWT lib choice (@tsndr/cloudflare-worker-jwt) is a guess
 * based on Worker compatibility — see PROPOSAL.md §7.2.
 *
 * Spec refs:
 *   EIP-712:  https://eips.ethereum.org/EIPS/eip-712
 *   SIWE:     https://eips.ethereum.org/EIPS/eip-4361
 *   viem:     https://viem.sh/docs/utilities/recoverTypedDataAddress
 *   Workers:  https://developers.cloudflare.com/workers/runtime-apis/
 */

import { recoverTypedDataAddress } from "viem";
import jwt from "@tsndr/cloudflare-worker-jwt";

export interface Env {
  JWT_SECRET: string;
  JWT_TTL_SECONDS?: string;
  AUTH_WINDOW_SEC?: string;
}

const domain = {
  name: "ARRA-MQTT",
  version: "1",
  chainId: 20260619,
} as const;

const types = {
  AuthHello: [
    { name: "from",       type: "address" },
    { name: "clientId",   type: "string"  },
    { name: "ts",         type: "uint64"  },
    { name: "blockHash",  type: "bytes32" },
    { name: "subs",       type: "string[]" },
  ],
} as const;

type AuthBody = {
  from: `0x${string}`;
  clientId: string;
  ts: number;
  blockHash: `0x${string}`;
  subs: string[];
  sig: `0x${string}`;
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handleAuth(req: Request, env: Env): Promise<Response> {
  let body: AuthBody;
  try {
    body = (await req.json()) as AuthBody;
  } catch {
    return json(400, { error: "bad json" });
  }

  // (1) ts window
  const ttl = Number(env.AUTH_WINDOW_SEC ?? "60");
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - body.ts) > ttl) {
    return json(401, { error: "stale", age: nowSec - body.ts });
  }

  // (2) recover sig
  let recovered: `0x${string}`;
  try {
    recovered = await recoverTypedDataAddress({
      domain,
      types,
      primaryType: "AuthHello",
      message: {
        from: body.from,
        clientId: body.clientId,
        ts: BigInt(body.ts),
        blockHash: body.blockHash,
        subs: body.subs,
      },
      signature: body.sig,
    });
  } catch (err) {
    return json(401, { error: "sig recover failed", detail: String(err) });
  }
  if (recovered.toLowerCase() !== body.from.toLowerCase()) {
    return json(401, { error: "from mismatch", claimed: body.from, recovered });
  }

  // (3) clientId binding — MQTT client_id must equal recovered address (lowercased).
  // This is what the broker ACL pattern `arra/<%c>/#` relies on.
  if (body.clientId.toLowerCase() !== recovered.toLowerCase()) {
    return json(401, { error: "clientId must equal recovered address" });
  }

  // (4) HONEST: blockHash freshness check is NOT done here — would require an RPC call
  // from the Worker. Per-message verifier handles freshness; CONNECT-time we only
  // bind identity. See PROPOSAL.md §7.3 — the round-trip-per-CONNECT cost.

  // (5) mint JWT
  const jwtTtl = Number(env.JWT_TTL_SECONDS ?? "300");
  const token = await jwt.sign(
    {
      sub: recovered.toLowerCase(),
      acl: [`arra/${recovered.toLowerCase()}/#`],
      iat: nowSec,
      exp: nowSec + jwtTtl,
    },
    env.JWT_SECRET,
    { algorithm: "HS256" }
  );

  return json(200, {
    token,
    expires_at: nowSec + jwtTtl,
    acl: [`arra/${recovered.toLowerCase()}/#`],
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return json(200, { ok: true, ts: Math.floor(Date.now() / 1000) });
    }
    if (req.method === "POST" && url.pathname === "/auth") {
      return handleAuth(req, env);
    }
    return json(404, { error: "not found" });
  },
};
