"""ArraMQ v2 — Layer 1 connect-gate for EMQX HTTP authentication.

EMQX POSTs {username, password} on CONNECT.
  username = 0xADDRESS
  password = base64(JSON{ address, issuedAt, sig })
             sig = EIP-712 Connect(address, issuedAt)   # chainId in the domain

Verifies the typed-data signature + freshness, returns allow + a per-address ACL.
Per-message integrity (topic/payload/seq) is enforced separately by verifier.py.

  pip install fastapi uvicorn eth-account
  uvicorn auth_service:app --host 0.0.0.0 --port 8080
"""
import base64, json, time
from fastapi import FastAPI, Response
from pydantic import BaseModel
from eth_account import Account
from eth_account.messages import encode_typed_data

CHAIN_ID, MAX_AGE, SKEW = 20260619, 600, 60
DOMAIN = {"name": "ArraMQ", "version": "1", "chainId": CHAIN_ID}
TYPES = {
    "EIP712Domain": [{"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                     {"name": "chainId", "type": "uint256"}],
    "Connect": [{"name": "address", "type": "address"}, {"name": "issuedAt", "type": "uint256"}],
}
app = FastAPI()

class AuthReq(BaseModel):
    username: str
    password: str

def _deny():
    return Response('{"result":"deny"}', media_type="application/json")

@app.post("/mqtt/auth")
def auth(req: AuthReq):
    try:
        b = json.loads(base64.b64decode(req.password))
        full = {"types": TYPES, "primaryType": "Connect", "domain": DOMAIN,
                "message": {"address": b["address"], "issuedAt": int(b["issuedAt"])}}
        signer = Account.recover_message(encode_typed_data(full_message=full), signature=b["sig"]).lower()
        if signer != req.username.lower() or signer != b["address"].lower():
            return _deny()
        now, ia = int(time.time()), int(b["issuedAt"])
        if now - ia > MAX_AGE or ia - now > SKEW:
            return _deny()
        return {"result": "allow",
                "acl": [{"permission": "allow", "action": "all", "topic": f"user/{signer}/#"}]}
    except Exception:
        return _deny()
