// ARRA-MQ Publisher v2 — EIP-712 typed data signing
import { privateKeyToAccount } from "viem/accounts";
import mqtt from "mqtt";

// DEV KEY ONLY — never use in production
const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
);

const DOMAIN = {
  name: "ARRA-MQTT",
  chainId: 20260619,
} as const;

const TYPES = {
  Message: [
    { name: "from", type: "address" },
    { name: "topic", type: "string" },
    { name: "ts", type: "uint256" },
    { name: "seq", type: "uint256" },
    { name: "data", type: "string" },
  ],
} as const;

let seq = 0;

async function main() {
  const ts = Math.floor(Date.now() / 1000);
  const connectMsg = `${account.address}:${ts}`;
  const connectSig = await account.signMessage({ message: connectMsg });

  const client = mqtt.connect("mqtt://localhost:1883", {
    username: account.address,
    password: `${connectSig}:${ts}`,
  });

  client.on("connect", () => {
    console.log(`Connected as ${account.address}`);

    setInterval(async () => {
      seq++;
      const now = Math.floor(Date.now() / 1000);
      const topic = "arra/sensor/room1";
      const data = JSON.stringify({ temp: 25.3 + Math.random() * 5 });

      const sig = await account.signTypedData({
        domain: DOMAIN,
        types: TYPES,
        primaryType: "Message",
        message: {
          from: account.address,
          topic,
          ts: BigInt(now),
          seq: BigInt(seq),
          data,
        },
      });

      const payload = JSON.stringify({
        data,
        topic,
        ts: now,
        seq,
        from: account.address,
        sig,
      });

      client.publish(topic, payload);
      console.log(`Published seq=${seq}: ${data}`);
    }, 5000);
  });

  client.on("error", (err) => console.error("MQTT error:", err));
}

main();
