// ARRA-MQ Publisher — sign every message with Ethereum wallet
import { privateKeyToAccount } from "viem/accounts";
import mqtt from "mqtt";

// DEV KEY ONLY — never use in production
const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
);

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
      const now = Math.floor(Date.now() / 1000);
      const data = JSON.stringify({ temp: 25.3 + Math.random() * 5 });
      const msg = `${data}:${now}`;
      const sig = await account.signMessage({ message: msg });

      const payload = JSON.stringify({
        data,
        ts: now,
        from: account.address,
        sig,
      });

      client.publish("arra/sensor/room1", payload);
      console.log(`Published: ${data}`);
    }, 5000);
  });

  client.on("error", (err) => console.error("MQTT error:", err));
}

main();
