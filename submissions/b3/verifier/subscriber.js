// Verifying subscriber — re-verifies every message E2E (delivery-topic bound), prints VALID/REJECT.
// Demonstrates: topic-in-signed-body + real EIP-712 + persisted seq.  B3 Oracle 🦁
import mqtt from "mqtt";
import { verifyMessage } from "./verify-msg.js";
import { persisted } from "./store.js";

const BROKER = process.env.BROKER || "mqtt://localhost:1883";
const client = mqtt.connect(BROKER, { username: "verifier", password: process.env.VERIFIER_TOKEN || "" });

client.on("connect", () => {
  console.log(`verifier up (replay store: ${persisted ? "Redis (persisted)" : "in-memory DEMO"})`);
  client.subscribe("arra/+/+/#");
});

client.on("message", async (deliveryTopic, buf) => {
  let env; try { env = JSON.parse(buf.toString()); } catch { return console.log(`✗ ${deliveryTopic}: bad json`); }
  const r = await verifyMessage(env, deliveryTopic);
  console.log(r.ok ? `✓ VALID  ${r.topic}  from ${r.from.slice(0,10)}… seq ${r.seq}`
                   : `✗ REJECT ${deliveryTopic}: ${r.reason}`);
});
client.on("error", (e) => console.log("mqtt error:", e.message));
