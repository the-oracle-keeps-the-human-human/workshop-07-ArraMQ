# ARRA-MQ — Configuration ตัวอย่าง

## 1. Cloudflare Worker (wrangler.toml)
```toml
name = "arra-mq-verify"
main = "verify-worker.ts"
compatibility_date = "2026-01-01"

kv_namespaces = [
  { binding = "STATE", id = "<kv-id>" }   # salt:cur/prev + seq:<addr>
]

[triggers]
crons = ["* * * * *"]   # rotate salt ทุก 1 นาที (scheduled handler)
```
deploy: `npx wrangler deploy` · KV: `npx wrangler kv:namespace create STATE`

## 2. EMQX — verify ตอน publish (rule → webhook ไป Worker)
```
# emqx rule: ทุก message.publish → POST ไป CF Worker /verify
# (Dashboard: Integration → Rules → SQL + Webhook action)
SQL:    SELECT payload, topic, clientid FROM "#"
ACTION: HTTP POST https://arra-mq-verify.<acct>.workers.dev/verify
        body = ${payload}     # { body, payload, sig }
        ถ้า resp ok:false → drop (republish ไม่ผ่าน)
```
หมายเหตุ: ถ้า verify ที่ subscriber app แทน → ไม่ต้องตั้ง rule นี้ (broker = ท่อเฉยๆ)

## 3. NanoMQ — bridge ขึ้น central EMQX (nanomq.conf)
```hcl
bridges.mqtt.emqx_cloud {
  server = "mqtt-tcp://emqx-central:1883"   # หรือ EMQX Cloud endpoint
  proto_ver = 5
  username = "edge-node-1"
  password = "<secret>"
  forwards = ["telemetry/#", "ctl/#"]        # egress: ส่งขึ้น central
  subscription = [{ topic = "cmd/#", qos = 1 }]   # ingress: รับคำสั่งลงมา
}
# NanoMQ มี rule-engine + webhook ในตัว → verify ที่ edge ได้เลยถ้าต้องการ
```

## 4. Mosquitto — bridge (mosquitto.conf) ถ้าใช้ Mosquitto เป็น edge
```conf
connection arra_bridge
address emqx-central:1883
remote_username edge-node-1
remote_password <secret>
topic telemetry/# out 1     # egress
topic ctl/# out 1
topic cmd/# in 1            # ingress
# Mosquitto: verify SIWE ทำที่ app-layer (ไม่มี native message hook)
```

## 5. Cloudflare robustness (เกิน HTTPS)
```
Worker      → verify SIWE (global edge)
KV / DO     → salt:cur/prev + seq:<addr> (consistent state)
CF DNS LB   → health-check failover ระหว่าง broker
CF Tunnel   → expose broker โดยไม่เปิด public IP (ฟรี)
CF Spectrum → proxy TCP/MQTT + DDoS L3/4 (enterprise, ตอน production)
```
