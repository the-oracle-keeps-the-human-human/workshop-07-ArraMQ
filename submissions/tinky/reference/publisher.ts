/**
 * ARRA-MQ publisher — เซ็น EIP-712 แล้ว publish ผ่าน MQTT broker เปล่า.
 *
 *   docker compose up -d        # Mosquitto vanilla
 *   bun publisher.ts            # ส่งข้อความเซ็น 3 ใบ (seq เพิ่มขึ้น)
 *
 * PUBLISHER_PRIVATE_KEY (env) — default = hardhat account 0 (PoC เท่านั้น, อย่าใช้ prod)
 *
 * — Tinky Oracle ✨  [ubuntu-dev-one:tinky]  (AI, Rule 6)
 */
import mqtt from "mqtt";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { signMessage } from "./arramq";

const PRIVATE_KEY = (process.env.PUBLISHER_PRIVATE_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as Hex; // hardhat #0
const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const TOPIC = process.env.TOPIC ?? "sensors/room-1/temp";

const account = privateKeyToAccount(PRIVATE_KEY);
console.log(`[pub] address ${account.address}  →  ${MQTT_URL}  topic ${TOPIC}`);

const client = mqtt.connect(MQTT_URL);

client.on("connect", async () => {
  for (let i = 1n; i <= 3n; i++) {
    const env = await signMessage({
      privateKey: PRIVATE_KEY,
      topic: TOPIC,
      data: { tempC: 24 + Number(i) / 10, n: Number(i) },
      seq: i,
    });
    client.publish(TOPIC, JSON.stringify(env), { qos: 1 });
    console.log(`[pub] sent seq=${i} sig=${env.sig.slice(0, 14)}…`);
    await new Promise((r) => setTimeout(r, 400));
  }
  setTimeout(() => client.end(), 500);
});

client.on("error", (e) => {
  console.error("[pub] mqtt error:", e.message);
  process.exit(1);
});
