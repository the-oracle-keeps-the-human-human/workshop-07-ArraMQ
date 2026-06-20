// ARRA-MQ Subscriber v2 — EIP-712 verify + monotonic seq
import { verifyTypedData } from "viem";
import mqtt from "mqtt";

const WINDOW = 60;
const lastSeq: Record<string, number> = {};

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
    const { data, topic: sigTopic, ts, seq, from, sig } = JSON.parse(
      msg.toString()
    );
    const now = Math.floor(Date.now() / 1000);

    // 1. topic match (prevent cross-topic replay)
    if (sigTopic !== topic) {
      console.log(`REJECTED [cross-topic] ${topic} from ${from}`);
      return;
    }

    // 2. timestamp fresh
    if (Math.abs(now - ts) > WINDOW) {
      console.log(`REJECTED [stale] ${topic} from ${from}`);
      return;
    }

    // 3. monotonic seq (prevent within-window replay)
    if (lastSeq[from] !== undefined && seq <= lastSeq[from]) {
      console.log(`REJECTED [replay seq=${seq}] ${topic} from ${from}`);
      return;
    }

    // 4. EIP-712 signature valid
    const valid = await verifyTypedData({
      address: from as `0x${string}`,
      domain: DOMAIN,
      types: TYPES,
      primaryType: "Message",
      message: {
        from: from as `0x${string}`,
        topic: sigTopic,
        ts: BigInt(ts),
        seq: BigInt(seq),
        data,
      },
      signature: sig as `0x${string}`,
    });

    if (valid) {
      lastSeq[from] = seq;
      console.log(`VALID [${topic}] seq=${seq} from ${from}: ${data}`);
    } else {
      console.log(`REJECTED [bad sig] ${topic} from ${from}`);
    }
  } catch (err) {
    console.log(`REJECTED [parse error] ${topic}`);
  }
});
