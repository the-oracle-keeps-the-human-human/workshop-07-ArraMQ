# ARRA-MQ (SIWE-Authenticated MQTT Broker) Proposal
**ผู้เสนอ**: No.6 Gemini (Research Companion, Oracle Council)

---

## 1. แนวคิดและหัวใจของระบบ (Core Concept)
หัวใจหลักของ **ARRA-MQ** คือ **"Trust lives in the message, not the broker"** (ความน่าเชื่อถืออยู่ที่ตัวข้อความและลายเซ็น ไม่ใช่ตัวกลางส่งผ่านข้อมูล) โดยการรวมดีไซน์เพื่อตอบสนองต่อ 3 เป้าหมายความปลอดภัยสำคัญ (Three-Axis Target) ของสภาอย่างสมบูรณ์แบบ:

1. **EIP-712 จริง (Typed Data Signing)**: แยกย่อยโดเมนและป้องกันการโจมตีข้ามเชน (Cross-Chain Replays) ด้วยการเซ็นแบบ Typed Data กำหนด `chainId` (ARRA L2 `20260619`) อย่างแท้จริง
2. **Topic-Binding ใน Signed Body**: ผนึกชื่อ Topic ปลายทางเข้าเป็นส่วนหนึ่งของข้อมูลที่มีลายเซ็นกำกับ เพื่อป้องกันไม่ให้ผู้บุกรุกสับเปลี่ยน (Broker Reroute) หรือดักข้ามหัวข้อ
3. **Persisted Monotonic Sequence (Seq Store)**: เก็บบันทึกหมายเลขลำดับ (Sequence Number) ของอุปกรณ์แต่ละเครื่องลงในคลังเก็บข้อมูลถาวร (Persistent Storage) เพื่อป้องกันการส่งซ้ำหลังระบบ Restart

---

## 2. โครงสร้างไฟล์ในโฟลเดอร์ส่งงาน (submissions/no6/)

- [README.md](file:///root/.no6-home/ghq/github.com/the-oracle-keeps-the-human-human/workshop-07-ArraMQ/submissions/no6/README.md): รายละเอียดข้อเสนอและการออกแบบระบบ
- [publisher.ts](file:///root/.no6-home/ghq/github.com/the-oracle-keeps-the-human-human/workshop-07-ArraMQ/submissions/no6/publisher.ts): ตัวอย่างไคลเอนต์จำลอง IoT ในการคำนวณลายเซ็น EIP-712 และส่งข้อความ
- [subscriber.ts](file:///root/.no6-home/ghq/github.com/the-oracle-keeps-the-human-human/workshop-07-ArraMQ/submissions/no6/subscriber.ts): ตัวอย่างตัวรับและตรวจสอบลายเซ็น E2E พร้อมระบบ Persisted Sequence Store (`seq_store.json`)
- [server.js](file:///root/.no6-home/ghq/github.com/the-oracle-keeps-the-human-human/workshop-07-ArraMQ/submissions/no6/server.js): ตัวอย่าง Auth Webhook สำหรับ Broker ในการคัดกรองตอน `CONNECT` (Stateless Time-Based Verification)
- [emqx_auth_webhook.conf](file:///root/.no6-home/ghq/github.com/the-oracle-keeps-the-human-human/workshop-07-ArraMQ/submissions/no6/emqx_auth_webhook.conf): ไฟล์ตัวอย่างการตั้งค่า HTTP Webhook ของ EMQX Broker

---

## 3. รายละเอียดการตรวจสอบสิทธิ์แบบ E2E (End-to-End Cryptography)

### 3.1 รูปแบบข้อความ EIP-712 (Typed Data Schema)
```typescript
const domain = {
  name: 'ARRA-MQTT',
  version: '1',
  chainId: 20260619 // ARRA Oracle Blockchain L2 Chain ID
};

const types = {
  ArraMQMessage: [
    { name: 'from', type: 'address' },
    { name: 'topic', type: 'string' },
    { name: 'ts', type: 'uint64' },
    { name: 'seq', type: 'uint64' },
    { name: 'data', type: 'string' }
  ]
};
```

### 3.2 การถอดลายเซ็นและป้องกัน Reroute / Replay
ตัวตรวจสอบใน [subscriber.ts](file:///root/.no6-home/ghq/github.com/the-oracle-keeps-the-human-human/workshop-07-ArraMQ/submissions/no6/subscriber.ts) จะทำหน้าที่ตรวจสอบเงื่อนไขดังนี้:
1. **Time-drift (Freshness Check)**: ข้อความต้องถูกส่งมาภายใน ±30 วินาทีจากเวลาปัจจุบัน (ป้องกันการเอาแฮชเก่าส่งมาซ้ำ)
2. **Topic Matching**: ตรวจสอบว่าหัวข้อจริงที่ได้รับผ่าน Broker ตรงกับค่า `envelope.topic` ในลายเซ็น เพื่อปิดการทำ Broker-Reroute
3. **Persisted Sequence DB**: ตรวจสอบค่า `seq` ที่เข้าเกณฑ์มากกว่าค่าล่าสุดที่จดไว้ในคลังเก็บถาวร (`seq_store.json` สำหรับเดโม และปรับเป็น Redis สำหรับโปรดักชันจริง)

---

## 4. วิธีทดสอบระบบเบื้องต้น (Local Demo)

1. ติดตั้ง Dependencies:
   ```bash
   npm install mqtt viem express
   ```
2. รัน Broker และรันไฟล์ตรวจสอบ:
   ```bash
   # Terminal 1: รันผู้รับและถอดลายเซ็น
   bun run subscriber.ts

   # Terminal 2: รันเครื่องจำลองส่งข้อมูล
   bun run publisher.ts
   ```

---
🤖 *No.6 Gemini จาก ai-core [Context: ~80%]*
