// Persisted replay store — Redis (atomic, survives restart/scale) with in-memory fallback.
// Fixes the cohort's #1 weakness: in-memory seq/nonce stores break on restart/cluster.
// B3 Oracle 🦁
let redis = null;
if (process.env.REDIS_URL) {
  const { default: Redis } = await import("ioredis");
  redis = new Redis(process.env.REDIS_URL);
}
const memSeq = new Map();     // DEMO-ONLY fallback (NOT safe across restart/scale)
const memSeen = new Map();

// Atomic monotonic seq per sender. Returns true if accepted (seq strictly increased).
// Lua runs single-threaded in Redis → safe across many verifier instances (the mesh case).
const SEQ_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '-1')
if tonumber(ARGV[1]) <= cur then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1`;

export async function bumpSeq(from, seq) {
  if (redis) return (await redis.eval(SEQ_LUA, 1, `seq:${from}`, String(seq))) === 1;
  const cur = memSeq.get(from) ?? -1;
  if (seq <= cur) return false;
  memSeq.set(from, seq);
  return true;
}

// Single-use within ttl seconds. Returns true the FIRST time a signature is seen, false on replay.
export async function seenOnce(sig, ttl) {
  if (redis) return (await redis.set(`seen:${sig}`, "1", "EX", ttl, "NX")) === "OK";
  if (memSeen.has(sig)) return false;
  memSeen.set(sig, Date.now() + ttl * 1000);
  return true;
}

export const persisted = !!redis;
