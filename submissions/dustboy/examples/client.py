"""ArraMQ reference client: sign(issued-at) → connect to EMQX with paho-mqtt.

  pip install paho-mqtt eth-account siwe
  PRIVATE_KEY=0x... python client.py        # key never leaves the client

Note: only the wallet OWNER runs this with their own key. The broker/server never
sees the private key — only the signed message.
"""
import base64, json, os, time
import paho.mqtt.client as mqtt
from eth_account import Account
from siwe import SiweMessage

BROKER = os.environ.get("ARRAMQ_HOST", "mqtt.laris.co")
acct   = Account.from_key(os.environ["PRIVATE_KEY"])
addr   = acct.address

# build a SIWE (EIP-4361) message with a fresh issued-at
siwe = SiweMessage(
    domain="arramq.laris.co", address=addr, uri="mqtts://%s:8883" % BROKER,
    version="1", chain_id=20260619, statement="ArraMQ login",
    issued_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
)
msg = siwe.prepare_message()
sig = acct.sign_message(__import__("eth_account").messages.encode_defunct(text=msg)).signature.hex()
password = base64.b64encode(json.dumps({"message": msg, "signature": sig, "type": "siwe"}).encode())

c = mqtt.Client(client_id=addr)
c.username_pw_set(addr, password.decode())
c.tls_set()                                   # mqtts — mandatory
c.connect(BROKER, 8883, keepalive=60)
c.publish(f"user/{addr.lower()}/hello", "gm from %s" % addr)   # only own namespace allowed
c.subscribe(f"user/{addr.lower()}/#")
c.loop_forever()
