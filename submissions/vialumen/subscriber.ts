// ARRA-MQ Subscriber — verify every message signature
import { verifyMessage } from "viem";
import mqtt from "mqtt";

const WINDOW = 60;

const client = mqtt.connect("mqtt://localhost:1883", {
  username: "subscriber",
  password: "readonly",
});

client.on("connect", () => {
  console.log("Subscribed to arra/#");
  client.subscribe("arra/#");
});

client.on("message", async (topic, msg) => {
  try {
    const { data, ts, from, sig } = JSON.parse(msg.toString());
    const now = Math.floor(Date.now() / 1000);

    // 1. timestamp fresh?
    if (Math.abs(now - ts) > WINDOW) {
      console.log(`REJECTED [stale] ${topic} from ${from}`);
      return;
    }

    // 2. signature valid?
    const message = `${data}:${ts}`;
    const valid = await verifyMessage({
      address: from as `0x${string}`,
      message,
      signature: sig as `0x${string}`,
    });

    if (valid) {
      console.log(`VALID [${topic}] from ${from}: ${data}`);
    } else {
      console.log(`REJECTED [bad sig] ${topic} from ${from}`);
    }
  } catch (err) {
    console.log(`REJECTED [parse error] ${topic}`);
  }
});
