/**
 * Self-test for ArraMQ verifier — runs 6 cases directly against verify() logic.
 *
 * No MQTT broker, no Nova RPC. Sets VERIFIER_SKIP_BLOCKHASH=1 to bypass the
 * on-chain block-hash freshness check (the freshness check is a separate concern
 * already covered by integration testing against a live RPC).
 *
 * Cases:
 *   1. valid sig                → ok
 *   2. tampered payload         → reject "payloadHash mismatch"
 *   3. wrong from addr          → reject "from mismatch"
 *   4. wrong chainId            → reject (domain separation flips recovered addr)
 *   5. delivery topic mismatch  → reject "topic mismatch"
 *   6. replay (same seq twice)  → reject "replay"
 *
 * Run:   bun test.ts        (or: bun run test)
 * Exit:  0 on all-pass, 1 on any-fail.
 *
 * Inspired by Weizen PR #13 self-test pattern (Oracle School workshop-07 cohort).
 */

// Force test mode BEFORE importing the verifier (verifier reads env at module load).
process.env.VERIFIER_SKIP_BLOCKHASH = "1";

import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { verify, type Envelope } from "./verifier.ts";

// EIP-712 domain — MUST stay byte-identical to publisher/verifier.
const domain = {
  name: "ARRA-MQTT",
  version: "1",
  chainId: 20260619,
} as const;

const types = {
  Msg: [
    { name: "from",        type: "address" },
    { name: "topic",       type: "string"  },
    { name: "ts",          type: "uint64"  },
    { name: "blockHash",   type: "bytes32" },
    { name: "seq",         type: "uint64"  },
    { name: "payloadHash", type: "bytes32" },
  ],
} as const;

// Deterministic test key — DEMO ONLY, well-known burner from viem test fixtures, no real funds.
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

type CaseResult = { name: string; pass: boolean; detail: string };
const results: CaseResult[] = [];

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  const tag = pass ? "PASS" : "FAIL";
  console.log(`[test] ${tag}  ${name}  — ${detail}`);
}

async function buildEnvelope(opts: {
  topic: string;
  payload: string;
  seq: bigint;
  ts?: bigint;
  chainIdOverride?: number;
  fromOverride?: `0x${string}`;
}): Promise<Envelope> {
  const account = privateKeyToAccount(TEST_KEY);
  const payloadHash = keccak256(toBytes(opts.payload));
  const ts = opts.ts ?? BigInt(Math.floor(Date.now() / 1000));
  const blockHash = ("0x" + "11".repeat(32)) as `0x${string}`;

  const msg = {
    from: account.address,
    topic: opts.topic,
    ts,
    blockHash,
    seq: opts.seq,
    payloadHash,
  } as const;

  const signDomain = opts.chainIdOverride
    ? { ...domain, chainId: opts.chainIdOverride }
    : domain;

  const sig = await account.signTypedData({
    domain: signDomain,
    types,
    primaryType: "Msg",
    message: msg,
  });

  return {
    v: 1,
    msg: {
      from: opts.fromOverride ?? msg.from,
      topic: msg.topic,
      ts: msg.ts.toString(),
      blockHash: msg.blockHash,
      seq: msg.seq.toString(),
      payloadHash: msg.payloadHash,
    },
    sig,
    payload: opts.payload,
  };
}

async function main() {
  const account = privateKeyToAccount(TEST_KEY);
  const topic = `arra/${account.address.toLowerCase()}/telemetry`;

  // ---- Case 1: valid -------------------------------------------------------
  {
    const env = await buildEnvelope({
      topic,
      payload: JSON.stringify({ case: 1, n: "valid" }),
      seq: 1001n,
    });
    const r = await verify(env, topic);
    record("01-valid-sig", r.ok === true, r.ok ? "ok" : `unexpected reject: ${r.reason}`);
  }

  // ---- Case 2: tampered payload --------------------------------------------
  {
    const env = await buildEnvelope({
      topic,
      payload: JSON.stringify({ case: 2, n: "original" }),
      seq: 1002n,
    });
    // Tamper AFTER sig is computed → payloadHash inside msg no longer matches actual payload
    env.payload = JSON.stringify({ case: 2, n: "TAMPERED" });
    const r = await verify(env, topic);
    const expected = !r.ok && r.reason.includes("payloadHash mismatch");
    record(
      "02-tampered-payload",
      expected,
      r.ok ? "unexpected ok" : `rejected: ${r.reason}`,
    );
  }

  // ---- Case 3: wrong from addr ---------------------------------------------
  {
    // viem checksums all addresses; use a lowercase well-known zero-derivative.
    const fake = "0x0000000000000000000000000000000000000001" as `0x${string}`;
    const env = await buildEnvelope({
      topic,
      payload: JSON.stringify({ case: 3, n: "wrong-from" }),
      seq: 1003n,
      fromOverride: fake,
    });
    const r = await verify(env, topic);
    const expected = !r.ok && r.reason.includes("from mismatch");
    record(
      "03-wrong-from",
      expected,
      r.ok ? "unexpected ok" : `rejected: ${r.reason}`,
    );
  }

  // ---- Case 4: wrong chainId in signing domain -----------------------------
  // Publisher signs with chainId=999 but verifier domain stays at 20260619.
  // EIP-712 domain separation → recovered address differs from msg.from → "from mismatch".
  {
    const env = await buildEnvelope({
      topic,
      payload: JSON.stringify({ case: 4, n: "wrong-chain" }),
      seq: 1004n,
      chainIdOverride: 999,
    });
    const r = await verify(env, topic);
    const expected = !r.ok && r.reason.includes("from mismatch");
    record(
      "04-wrong-chainId",
      expected,
      r.ok ? "unexpected ok" : `rejected: ${r.reason}`,
    );
  }

  // ---- Case 5: delivery topic mismatch (reroute attack) --------------------
  {
    const env = await buildEnvelope({
      topic,
      payload: JSON.stringify({ case: 5, n: "reroute" }),
      seq: 1005n,
    });
    // Verifier sees this message on a DIFFERENT topic than what was signed.
    const r = await verify(env, "arra/0xattacker/cmd");
    const expected = !r.ok && r.reason.includes("topic mismatch");
    record(
      "05-topic-mismatch",
      expected,
      r.ok ? "unexpected ok" : `rejected: ${r.reason}`,
    );
  }

  // ---- Case 6: replay (same envelope twice) --------------------------------
  {
    const env = await buildEnvelope({
      topic,
      payload: JSON.stringify({ case: 6, n: "replay" }),
      seq: 1006n,
    });
    const r1 = await verify(env, topic);
    const r2 = await verify(env, topic);
    const expected = r1.ok === true && r2.ok === false && r2.reason.includes("replay");
    record(
      "06-replay",
      expected,
      `first=${r1.ok ? "ok" : r1.reason}  second=${r2.ok ? "ok" : r2.reason}`,
    );
  }

  // ---- summary -------------------------------------------------------------
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n[test] summary: ${passed}/${total} PASS`);
  if (passed !== total) {
    console.log("[test] failures:");
    for (const r of results.filter((x) => !x.pass)) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(1);
});
