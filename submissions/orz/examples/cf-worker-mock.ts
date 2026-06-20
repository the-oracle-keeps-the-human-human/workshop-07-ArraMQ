/**
 * cf-worker-mock — local Express stub that mimics the real CF Worker (cf-worker.ts).
 *
 * Used by docker-compose.yml so the demo runs OFFLINE without a real Cloudflare deploy.
 *
 * Endpoints (same shape as cf-worker.ts):
 *   POST /auth
 *   GET  /health
 *
 * Run:
 *   bun examples/cf-worker-mock.ts
 *   # or in compose: see docker-compose.yml service `cf-worker-mock`
 *
 * HONEST: shares verify logic with cf-worker.ts but uses Node `crypto` + a tiny HMAC JWT
 * instead of the @tsndr Worker JWT lib — they should be byte-compatible for HS256 but
 * this is NOT a guarantee. See PROPOSAL.md §7.2.
 */

import express from "express";
import { createHmac, randomBytes } from "node:crypto";
import { recoverTypedDataAddress } from "viem";

const PORT = Number(process.env.PORT ?? 8787);
const JWT_SECRET = process.env.JWT_SECRET ?? randomBytes(32).toString("hex");
const JWT_TTL_SECONDS = Number(process.env.JWT_TTL_SECONDS ?? 300);
const AUTH_WINDOW_SEC = Number(process.env.AUTH_WINDOW_SEC ?? 60);

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

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signHS256(payload: object, secret: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const sig = b64url(createHmac("sha256", secret).update(data).digest());
  return `${data}.${sig}`;
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Math.floor(Date.now() / 1000), mode: "mock" });
});

app.post("/auth", async (req, res) => {
  const body = req.body as {
    from: `0x${string}`;
    clientId: string;
    ts: number;
    blockHash: `0x${string}`;
    subs: string[];
    sig: `0x${string}`;
  };

  const nowSec = Math.floor(Date.now() / 1000);
  if (!body?.ts || Math.abs(nowSec - body.ts) > AUTH_WINDOW_SEC) {
    return res.status(401).json({ error: "stale" });
  }

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
    return res.status(401).json({ error: "sig recover failed", detail: String(err) });
  }

  if (recovered.toLowerCase() !== body.from.toLowerCase()) {
    return res.status(401).json({ error: "from mismatch", recovered });
  }
  if (body.clientId.toLowerCase() !== recovered.toLowerCase()) {
    return res.status(401).json({ error: "clientId must equal recovered address" });
  }

  const acl = [`arra/${recovered.toLowerCase()}/#`];
  const token = signHS256(
    { sub: recovered.toLowerCase(), acl, iat: nowSec, exp: nowSec + JWT_TTL_SECONDS },
    JWT_SECRET
  );

  return res.json({ token, expires_at: nowSec + JWT_TTL_SECONDS, acl });
});

app.listen(PORT, () => {
  console.log(`[cf-worker-mock] listening on :${PORT}`);
});
