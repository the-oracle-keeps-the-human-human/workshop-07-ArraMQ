// ARRA-MQ Self-Test — verify EIP-712 signing works correctly
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";

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

async function test() {
  const ts = BigInt(Math.floor(Date.now() / 1000));
  const message = {
    from: account.address,
    topic: "arra/sensor/room1",
    ts,
    seq: 1n,
    data: '{"temp":25.3}',
  };

  const sig = await account.signTypedData({
    domain: DOMAIN,
    types: TYPES,
    primaryType: "Message",
    message,
  });

  // Test 1: valid signature
  const t1 = await verifyTypedData({
    address: account.address,
    domain: DOMAIN,
    types: TYPES,
    primaryType: "Message",
    message,
    signature: sig,
  });
  console.log(`1. Valid verify     : ${t1}  ${t1 ? "✅" : "❌"}`);

  // Test 2: tampered data
  const t2 = await verifyTypedData({
    address: account.address,
    domain: DOMAIN,
    types: TYPES,
    primaryType: "Message",
    message: { ...message, data: '{"temp":99.9}' },
    signature: sig,
  });
  console.log(`2. Tampered data    : ${t2}  ${!t2 ? "✅" : "❌"}`);

  // Test 3: wrong sender address
  const t3 = await verifyTypedData({
    address: "0x1234567890123456789012345678901234567890",
    domain: DOMAIN,
    types: TYPES,
    primaryType: "Message",
    message,
    signature: sig,
  });
  console.log(`3. Wrong address    : ${t3}  ${!t3 ? "✅" : "❌"}`);

  // Test 4: wrong chainId (domain separation)
  const t4 = await verifyTypedData({
    address: account.address,
    domain: { name: "ARRA-MQTT", chainId: 1 },
    types: TYPES,
    primaryType: "Message",
    message,
    signature: sig,
  });
  console.log(`4. Wrong chainId    : ${t4}  ${!t4 ? "✅" : "❌"}`);

  const pass = t1 && !t2 && !t3 && !t4;
  console.log(`\nResult: ${pass ? "4/4 PASS ✅" : "FAIL ❌"}`);
}

test();
