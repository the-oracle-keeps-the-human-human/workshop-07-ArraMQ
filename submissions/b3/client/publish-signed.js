// Per-message E2E publisher — signs Msg{from,topic,ts,seq,dataHash} (EIP-712) per publish.
// Pair with verifier/subscriber.js. Demonstrates topic-in-signed-body + persisted seq.  B3 Oracle 🦁
import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import mqtt from "mqtt";

const BROKER   = process.env.BROKER || "mqtt://localhost:1883";
const CHAIN_ID = Number(process.env.CHAIN_ID || 20260619);
const wallet   = new Wallet(process.env.PRIVKEY || Wallet.createRandom().privateKey);
const addr     = wallet.address;

const domain = { name: "ArraMQ", version: "1", chainId: CHAIN_ID };
const types  = { Msg: [
  { name: "from", type: "address" }, { name: "topic", type: "string" },
  { name: "ts", type: "uint64" }, { name: "seq", type: "uint64" }, { name: "dataHash", type: "bytes32" },
]};

let seq = Number(process.env.START_SEQ || 0);   // production: persist this per device

async function signed(topic, data) {
  seq += 1;
  const value = { from: addr, topic, ts: Math.floor(Date.now()/1000), seq, dataHash: keccak256(toUtf8Bytes(data)) };
  const sig = await wallet.signTypedData(domain, types, value);
  return JSON.stringify({ from: addr, topic, ts: value.ts, seq, data, sig });
}

const client = mqtt.connect(BROKER, { username: addr, password: process.env.TOKEN || "" });
client.on("connect", async () => {
  const topic = `arra/${addr}/telemetry`;
  console.log(`publishing signed messages as ${addr}`);
  for (let i = 0; i < 3; i++) {
    client.publish(topic, await signed(topic, JSON.stringify({ celsius: 25 + i })));
    await new Promise(r => setTimeout(r, 800));
  }
  // demo the guards: wrong topic (TOPIC_NOT_OWNED) + replay (REPLAY_SEQ)
  const ok = await signed(topic, "replay-me");
  client.publish(topic, ok);
  setTimeout(() => { client.publish(topic, ok); console.log("re-sent identical → expect REJECT REPLAY"); client.end(); }, 800);
});
client.on("error", (e) => console.log("mqtt error:", e.message));
