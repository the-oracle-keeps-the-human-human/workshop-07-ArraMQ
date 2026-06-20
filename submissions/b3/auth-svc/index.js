// ArraMQ auth-svc — verify a time-based EIP-712 (or SIWE) signature → mint a short-lived MQTT token.
// "Identity lives in the signed message, not the broker."  B3 Oracle 🦁
import express from "express";
import jwt from "jsonwebtoken";
import { verifyTypedData, getAddress } from "ethers";

const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";   // shared with EMQX (HS256)
const MAX_AGE_S  = 60;          // time-based freshness window (no nonce store)
const TOKEN_TTL  = 3 * 3600;    // 3h session
const CHAIN_ID   = Number(process.env.CHAIN_ID || 20260619);

// EIP-712 typed schema — machine-friendly, no string parsing.
const domain = { name: "ArraMQ", version: "1", chainId: CHAIN_ID };
const types  = { Auth: [
  { name: "address",  type: "address" },
  { name: "issuedAt", type: "uint256" },   // unix seconds, signed by the wallet
  { name: "scope",    type: "string"  },   // e.g. "pubsub"
]};

const seen = new Map();   // optional replay-proofing: signature -> expiry (lazy nonce)
setInterval(() => { const now = Date.now(); for (const [k,v] of seen) if (v < now) seen.delete(k); }, 30_000);

const app = express();
app.use(express.json());

app.post("/auth", (req, res) => {
  try {
    const { address, issuedAt, scope, signature } = req.body;
    const value = { address: getAddress(address), issuedAt, scope };

    // 1) signature must recover the claimed address
    const recovered = verifyTypedData(domain, types, value, signature);
    if (getAddress(recovered) !== getAddress(address))
      return res.status(401).json({ error: "signature/address mismatch" });

    // 2) time-based freshness — "how old is the signature?"
    const ageS = Math.floor(Date.now() / 1000) - Number(issuedAt);
    if (ageS < -30 || ageS > MAX_AGE_S)
      return res.status(401).json({ error: `stale or future signature (age ${ageS}s)` });

    // 3) optional replay-proof without a pre-fetched nonce
    if (seen.has(signature)) return res.status(401).json({ error: "replay" });
    seen.set(signature, Date.now() + MAX_AGE_S * 1000);

    // 4) mint MQTT token with per-wallet EMQX ACL claim
    const addr = getAddress(address);
    const token = jwt.sign(
      { sub: addr,
        acl: { sub: [`arra/${addr}/#`], pub: [`arra/${addr}/status`] } },
      JWT_SECRET, { algorithm: "HS256", expiresIn: TOKEN_TTL });

    res.json({ token, address: addr, exp_in: TOKEN_TTL });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/health", (_q, r) => r.json({ ok: true }));
app.listen(PORT, () => console.log(`ArraMQ auth-svc on :${PORT} (chainId ${CHAIN_ID})`));
