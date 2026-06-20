"""ArraMQ v2 — per-message E2E verifier (Layer 2, the core).

Broker-agnostic: a subscriber, or a verifying bridge that republishes only valid
messages, calls Verifier.verify() on each incoming MQTT message. Closes the three
properties the workshop cohort each had only partially:
  1. topic-in-signed-body    EIP-712 Publish.topic must equal the DELIVERY topic
  2. real EIP-712            chainId is in the domain -> enters the digest
  3. persisted monotonic seq Redis Lua CAS -> survives verifier restart/scale AND
                             is atomic (no get-then-put TOCTOU race)

MQTT payload wire format (JSON):
  { "msg": {"topic","payloadHash","issuedAt","seq"}, "data": <str>, "sig": "0x.." }
Publisher address is RECOVERED from sig, never trusted from the wire.

  pip install eth-account eth-utils redis
  # self-test needs a redis:  docker compose up -d redis  then  python verifier.py
"""
import json, os, time
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak
import redis

CHAIN_ID = 20260619
MAX_AGE  = 600          # connect/message freshness window (s)
SKEW     = 60           # future-dated tolerance (s)

DOMAIN = {"name": "ArraMQ", "version": "1", "chainId": CHAIN_ID}
TYPES = {
    "EIP712Domain": [
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
    ],
    "Publish": [
        {"name": "topic", "type": "string"},
        {"name": "payloadHash", "type": "bytes32"},
        {"name": "issuedAt", "type": "uint256"},
        {"name": "seq", "type": "uint256"},
    ],
}

# atomic monotonic compare-and-set — no get-then-put race (eventual-consistency safe)
_CAS = """
local cur = tonumber(redis.call('GET', KEYS[1]) or '-1')
if tonumber(ARGV[1]) > cur then redis.call('SET', KEYS[1], ARGV[1]); return 1 else return 0 end
"""


class Verifier:
    def __init__(self, redis_url=None, allowlist=None):
        self.r = redis.Redis.from_url(redis_url or os.environ.get("REDIS_URL", "redis://localhost:6379/0"))
        self._cas = self.r.register_script(_CAS)
        self.allowlist = {a.lower() for a in allowlist} if allowlist else None

    def verify(self, delivery_topic, raw):
        """Returns (ok: bool, info: signer-address-or-reason)."""
        try:
            env = json.loads(raw)
            m = env["msg"]
            full = {"types": TYPES, "primaryType": "Publish", "domain": DOMAIN, "message": {
                "topic": m["topic"],
                "payloadHash": bytes.fromhex(m["payloadHash"][2:]),
                "issuedAt": int(m["issuedAt"]),
                "seq": int(m["seq"]),
            }}
            signer = Account.recover_message(encode_typed_data(full_message=full),
                                             signature=env["sig"]).lower()
        except Exception as e:
            return False, f"bad-signature:{e}"

        # 0. IDENTITY: the topic namespace must belong to the recovered signer.
        #    ArraMQ ACL is user/<addr>/# -> a publish to user/0xAAA/.. must recover to 0xAAA.
        #    This also makes a wrong-chainId signature fail: a different domain recovers a
        #    DIFFERENT address, which then won't own the topic. (allowlist for shared topics.)
        parts = delivery_topic.split("/")
        if len(parts) >= 2 and parts[0] == "user":
            if parts[1].lower() != signer:
                return False, "topic-not-owned-by-signer"
        elif self.allowlist is not None and signer not in self.allowlist:
            return False, "not-authorized"
        if m["topic"] != delivery_topic:                                   # 1. topic-binding
            return False, "topic-mismatch"
        if "0x" + keccak(env["data"].encode()).hex() != m["payloadHash"].lower():  # 2. payload-binding
            return False, "payload-hash-mismatch"
        now, ia = int(time.time()), int(m["issuedAt"])                     # 3. freshness
        if now - ia > MAX_AGE or ia - now > SKEW:
            return False, "stale-or-future"
        if not self._cas(keys=[f"seq:{signer}:{delivery_topic}"], args=[int(m["seq"])]):  # 4. monotonic
            return False, "replay-or-stale-seq"
        return True, signer


# --- runnable self-test (proves the 3 properties) ---
if __name__ == "__main__":
    acct = Account.from_key("0x" + "11" * 32)
    addr = acct.address

    def sign_pub(topic, data, seq, ia=None, chain=CHAIN_ID):
        ia = ia or int(time.time())
        dom = {"name": "ArraMQ", "version": "1", "chainId": chain}
        full = {"types": TYPES, "primaryType": "Publish", "domain": dom, "message": {
            "topic": topic, "payloadHash": bytes.fromhex(keccak(data.encode()).hex()),
            "issuedAt": ia, "seq": seq}}
        sig = acct.sign_message(encode_typed_data(full_message=full)).signature.hex()
        return json.dumps({"msg": {"topic": topic, "payloadHash": "0x" + keccak(data.encode()).hex(),
                                   "issuedAt": ia, "seq": seq}, "data": data, "sig": sig})

    v = Verifier()
    T = f"user/{addr.lower()}/telemetry"        # ArraMQ namespace owned by the signer
    CMD = f"user/{addr.lower()}/cmd"
    v.r.delete(f"seq:{addr.lower()}:{T}")
    cases = [
        ("valid",                v.verify(T, sign_pub(T, "pm25=12", 1)),               True),
        ("replay same seq",      v.verify(T, sign_pub(T, "pm25=12", 1)),               False),
        ("monotonic next",       v.verify(T, sign_pub(T, "pm25=13", 2)),               True),
        ("tampered data",        v.verify(T, sign_pub(T, "pm25=13", 3).replace("pm25=13", "pm25=99")), False),
        ("wrong delivery topic", v.verify(CMD, sign_pub(T, "open", 4)),                False),
        ("wrong chainId",        v.verify(T, sign_pub(T, "pm25=14", 5, chain=1)),      False),
        ("foreign namespace",    v.verify("user/0xdeadbeef/telemetry", sign_pub("user/0xdeadbeef/telemetry", "x", 6)), False),
    ]
    ok = True
    for name, (got, info), want in cases:
        flag = "PASS" if got == want else "FAIL"
        if got != want: ok = False
        print(f"[{flag}] {name:22} -> ok={got} ({info})")
    print("ALL PASS" if ok else "SELF-TEST FAILED"); raise SystemExit(0 if ok else 1)
