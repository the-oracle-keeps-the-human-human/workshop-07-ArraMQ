"""ArraMQ v2 reference client — connect (EIP-712) + per-message E2E (EIP-712).

Only the wallet OWNER runs this with their own key; the broker/verifier never sees
the private key — only signed typed-data.

  pip install paho-mqtt eth-account eth-utils
  PRIVATE_KEY=0x... python client.py
"""
import base64, json, os, time
import paho.mqtt.client as mqtt
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak

CHAIN_ID = 20260619
BROKER = os.environ.get("ARRAMQ_HOST", "mqtt.laris.co")
acct = Account.from_key(os.environ["PRIVATE_KEY"])
addr = acct.address
DOMAIN = {"name": "ArraMQ", "version": "1", "chainId": CHAIN_ID}
_DOM_T = [{"name": "name", "type": "string"}, {"name": "version", "type": "string"},
          {"name": "chainId", "type": "uint256"}]

def _sign(types, primary, message):
    full = {"types": {"EIP712Domain": _DOM_T, **types}, "primaryType": primary,
            "domain": DOMAIN, "message": message}
    return acct.sign_message(encode_typed_data(full_message=full)).signature.hex()

# connect-layer credential: EIP-712 Connect(address, issuedAt)
issued = int(time.time())
conn_sig = _sign({"Connect": [{"name": "address", "type": "address"}, {"name": "issuedAt", "type": "uint256"}]},
                 "Connect", {"address": addr, "issuedAt": issued})
password = base64.b64encode(json.dumps({"address": addr, "issuedAt": issued, "sig": conn_sig}).encode())

# per-message envelope: EIP-712 Publish(topic, payloadHash, issuedAt, seq)
_PUB_T = {"Publish": [{"name": "topic", "type": "string"}, {"name": "payloadHash", "type": "bytes32"},
                      {"name": "issuedAt", "type": "uint256"}, {"name": "seq", "type": "uint256"}]}
SEQ_FILE = os.path.expanduser(f"~/.arramq_seq_{addr.lower()}")  # local monotonic, persisted

def next_seq():
    s = (int(open(SEQ_FILE).read()) + 1) if os.path.exists(SEQ_FILE) else 1
    open(SEQ_FILE, "w").write(str(s)); return s

def signed_publish(client, topic, data):
    ph = "0x" + keccak(data.encode()).hex()
    seq, ia = next_seq(), int(time.time())
    sig = _sign(_PUB_T, "Publish", {"topic": topic, "payloadHash": bytes.fromhex(ph[2:]),
                                    "issuedAt": ia, "seq": seq})
    client.publish(topic, json.dumps({"msg": {"topic": topic, "payloadHash": ph, "issuedAt": ia, "seq": seq},
                                      "data": data, "sig": sig}))

c = mqtt.Client(client_id=addr)
c.username_pw_set(addr, password.decode())
c.tls_set()                                   # mqtts — mandatory
c.connect(BROKER, 8883, keepalive=60)
signed_publish(c, f"user/{addr.lower()}/telemetry", "pm25=12.4")   # signs topic+payload+seq
c.loop_forever()
