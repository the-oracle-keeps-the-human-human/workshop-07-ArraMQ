// ArraMQ client — sign a time-based EIP-712 message, exchange for a token, connect to MQTT.
// The thin "wrapper loop": sign -> token -> connect, refresh on expiry.  B3 Oracle 🦁
import { Wallet } from "ethers";
import mqtt from "mqtt";

const AUTH = process.env.AUTH_URL || "http://localhost:3000/auth";
const BROKER = process.env.BROKER || "mqtt://localhost:1883";
const CHAIN_ID = Number(process.env.CHAIN_ID || 20260619);
const wallet = new Wallet(process.env.PRIVKEY || Wallet.createRandom().privateKey);

const domain = { name: "ArraMQ", version: "1", chainId: CHAIN_ID };
const types  = { Auth: [
  { name: "address",  type: "address" },
  { name: "issuedAt", type: "uint256" },
  { name: "scope",    type: "string"  },
]};

async function getToken() {
  const value = { address: wallet.address, issuedAt: Math.floor(Date.now()/1000), scope: "pubsub" };
  const signature = await wallet.signTypedData(domain, types, value);     // no /nonce round-trip
  const r = await fetch(AUTH, { method: "POST", headers: { "content-type": "application/json" },
                               body: JSON.stringify({ ...value, signature }) });
  if (!r.ok) throw new Error(`auth failed: ${(await r.json()).error}`);
  return (await r.json()).token;
}

async function main() {
  const token = await getToken();
  const addr = wallet.address;
  const client = mqtt.connect(BROKER, { username: addr, password: token, reconnectPeriod: 2000 });

  client.on("connect", () => {
    console.log(`✅ connected as ${addr}`);
    client.subscribe(`arra/${addr}/test`, (e) => console.log(e ? `sub err ${e}` : "subscribed (own topic) ✅"));
    client.subscribe(`arra/0xSOMEONE_ELSE/test`, (e) =>     // must be DENIED by ACL
      console.log(e ? "denied foreign topic ✅ (expected)" : "❌ ACL LEAK"));
    client.publish(`arra/${addr}/status`, "hello from a signed identity");
  });
  client.on("message", (t, m) => console.log(`📩 ${t}: ${m}`));
  client.on("error", (e) => console.log("mqtt error:", e.message));
  // On token expiry the broker rejects reconnect → fetch a fresh token and reconnect:
  client.on("close", async () => { try { client.options.password = await getToken(); } catch {} });
}
main();
