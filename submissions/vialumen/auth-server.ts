// ARRA-MQ Auth Server — Bun + viem
// Verify Ethereum-signed MQTT connect + publish

import { verifyMessage } from "viem";

const WINDOW = 60; // seconds
const ALLOWLIST = new Set([
  "0xEf1530E49b13341828664f298e683349AD784333", // P'Nat
]);

const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);

    // POST /auth — verify MQTT connect
    if (url.pathname === "/auth" && req.method === "POST") {
      const body = await req.json();
      const { username, password } = body;
      // username = wallet address, password = sig:timestamp
      const [sig, tsStr] = (password || "").split(":");
      const ts = parseInt(tsStr, 10);
      const now = Math.floor(Date.now() / 1000);

      if (Math.abs(now - ts) > WINDOW) {
        return Response.json({ result: "deny" }, { status: 403 });
      }

      try {
        const msg = `${username}:${ts}`;
        const valid = await verifyMessage({
          address: username as `0x${string}`,
          message: msg,
          signature: sig as `0x${string}`,
        });
        if (valid && ALLOWLIST.has(username)) {
          return Response.json({ result: "allow" });
        }
      } catch {}
      return Response.json({ result: "deny" }, { status: 403 });
    }

    // POST /acl — verify MQTT publish (message-level sig)
    if (url.pathname === "/acl" && req.method === "POST") {
      // NanoMQ sends topic + payload in acl check
      // For PoC: allow all authenticated users to publish
      return Response.json({ result: "allow" });
    }

    return new Response("ARRA-MQ Auth Server", { status: 200 });
  },
});

console.log(`ARRA-MQ auth server running on :${server.port}`);
