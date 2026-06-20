"""ArraMQ auth backend for EMQX HTTP authentication.

EMQX POSTs {clientid, username, password} on CONNECT.
  username = 0xADDRESS
  password = base64( JSON{ "message": <str>, "signature": "0x..", "type": "siwe"|"eip712" } )

We recover the signer, assert it == username, and assert the signed issued-at
timestamp is within MAX_AGE. Stateless: no nonce store.

  pip install fastapi uvicorn eth-account siwe
  uvicorn auth_service:app --host 0.0.0.0 --port 8080
"""
import base64, json, time
from datetime import datetime, timezone
from fastapi import FastAPI, Response
from pydantic import BaseModel
from eth_account import Account
from eth_account.messages import encode_defunct, encode_typed_data

MAX_AGE = 600          # seconds — the freshness window (keep short; TLS is mandatory)
SKEW    = 60           # clock-skew tolerance

app = FastAPI()

class AuthReq(BaseModel):
    clientid: str | None = None
    username: str        # the claimed 0xADDRESS
    password: str        # base64(JSON{message,signature,type})

def _age_ok(issued_at_epoch: float) -> bool:
    now = time.time()
    return (now - issued_at_epoch) <= MAX_AGE and issued_at_epoch <= now + SKEW

def _recover(msg: str, sig: str, kind: str) -> str:
    if kind == "eip712":
        typed = json.loads(msg)                      # full EIP-712 typed-data doc
        return Account.recover_message(encode_typed_data(full_message=typed), signature=sig)
    return Account.recover_message(encode_defunct(text=msg), signature=sig)   # SIWE / personal_sign

def _issued_at(msg: str, kind: str) -> float:
    if kind == "eip712":
        return float(json.loads(msg)["message"]["issuedAt"])      # epoch seconds in the typed msg
    # SIWE string carries  "Issued At: <ISO-8601>"
    for line in msg.splitlines():
        if line.startswith("Issued At:"):
            iso = line.split("Issued At:", 1)[1].strip()
            return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    raise ValueError("no Issued At in SIWE message")

@app.post("/mqtt/auth")
def auth(req: AuthReq):
    try:
        body = json.loads(base64.b64decode(req.password))
        kind = body.get("type", "siwe")
        signer = _recover(body["message"], body["signature"], kind)
        if signer.lower() != req.username.lower():
            return Response('{"result":"deny"}', media_type="application/json")
        if not _age_ok(_issued_at(body["message"], kind)):
            return Response('{"result":"deny"}', media_type="application/json")
        # allow + scope ACL to this address (EMQX reads the acl claim)
        acl = [{"permission": "allow", "action": "all",
                "topic": f"user/{signer.lower()}/#"}]
        return {"result": "allow", "acl": acl}
    except Exception:
        return Response('{"result":"deny"}', media_type="application/json")
