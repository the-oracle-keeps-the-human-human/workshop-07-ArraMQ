# ARRA-MQ (SIWE-Authenticated MQTT Broker) Proposal
**ผู้เสนอ**: No.6 Gemini (Research Companion, Oracle Council)

---

## 1. แนวคิดและหัวใจของระบบ (Core Concept)
หัวใจหลักของ **ARRA-MQ** คือ **"Trust lives in the message, not the broker"** (ความน่าเชื่อถืออยู่ที่ตัวข้อความและลายเซ็น ไม่ใช่ตัวกลางส่งผ่านข้อมูล) โดยใช้ **Sign-In with Ethereum (SIWE / EIP-4361)** และ **Ethereum Signatures** ในการยืนยันตัวตนของผู้ใช้งานและอุปกรณ์ปลายทาง เพื่อตัดภาระการใช้ Token หรือ User/Password แบบดั้งเดิมออกไปทั้งหมด

---

## 2. โครงสร้างสถาปัตยกรรม (Architectural Overview)

```
   [ Client App ] --(1) SIWE Message + Signature--> [ ARRA-MQ Gateway ] (Port 1883/8883)
         |                                                   |
         |                                           (Verify SIWE Address & Time-drift)
         |                                                   |
         |<--(2) Connection Approved (HTTP 200/OK)-----------+
         |
      [ Publish/Subscribe ]
         |
         +--(3) Message { payload, timestamp, sig } ----------------------------> [ Subscribers ]
                                                                                     |
                                                                             (Verify payload sig)
```

การทำงานแบ่งออกเป็น 2 ชั้นหลัก:
1. **Gate Connection (CONNECT Auth)**: คอยสกรีนสิทธิ์การเชื่อมต่อเบื้องต้นแบบไร้รอยต่อ (Stateless Gateway)
2. **Message-Level Security**: ทุกข้อความที่ไหลผ่าน Broker จะถูกเซ็นกำกับด้วยกุญแจส่วนตัว of Client ทำให้ปลายทางสามารถถอดรหัสตรวจสอบผู้ส่งจริงได้ 100% แม้ Broker จะถูกโจมตี

---

## 3. รายละเอียดการออกแบบทางเทคนิค (Technical Specifications)

### 3.1 การตรวจสอบสิทธิ์การเชื่อมต่อแบบ Stateless Time-Based
เพื่อหลีกเลี่ยงภาระของ Nonce Database หรือความจำเป็นในการทำ Stateful Session หลังบ้าน เราเสนอสถาปัตยกรรมแบบ **Time-Based Agreement** ที่มีหน้าต่างเวลาในการยอมรับ (Drift Window):

* **Username**: `Client Address` (เช่น `0xAddress...`)
* **Password**: `timestamp:signature`
  * `timestamp` = เวลา Epoch วินาที (เช่น `1782012045`)
  * `signature` = ลายเซ็นที่เซ็นกำกับข้อความมาตรฐาน: `sign("SIWE-MQTT Connect: <address> at <timestamp>")`

**ขั้นตอนการตรวจสอบสิทธิ์ฝั่ง Broker (Webhook Verify):**
1. เมื่อมีการส่ง `CONNECT` packet เข้ามา Broker (ผ่าน Webhook ปลั๊กอิน) จะแยก Password ออกเป็น `timestamp` และ `signature`
2. ตรวจสอบการเลื่อนของเวลา (Time Drift Check): `abs(now - timestamp) < 30 seconds` หากค่าเกินกว่า 30 วินาทีจะปฏิเสธการเชื่อมต่อทันทีเพื่อป้องกันการนำข้อความเก่าวัดการเชื่อมต่อซ้ำ (Replay Attack)
3. กู้คืนที่อยู่กระเป๋า (Recover Signer Address) จาก signature
4. ตรวจสอบที่อยู่กระเป๋าที่กู้คืนมาได้ว่าตรงกับ `Username` หรือไม่ หากตรงกันให้ส่งรหัส HTTP `200` ยอมรับการเชื่อมต่อ

### 3.2 ระบบควบคุมสิทธิ์หัวข้อรับส่งข้อมูล (Topic ACL)
การควบคุมเส้นทางการส่งข้อมูล (Publish / Subscribe) จะจัดสิทธิ์ตาม Ethereum Address แบบไดนามิก:
- **Publish ACL**: `device/<address>/telemetry` และ `user/<address>/request`
- **Subscribe ACL**: `device/<address>/commands` และ `user/<address>/response`
- *เพิ่มเติม*: ระบบสามารถเชื่อมต่อ Webhook ไปเช็คยอดโทเค็น (Token-Gating) หรือการถือสิทธิ์ NFT บน L2 (ARRA Chain / Nova) เพื่อปลดล็อก ACL ของ Broker ได้แบบเรียลไทม์

### 3.3 การป้องกันขั้นสูง (Replay & Future Command MITM Prevention)
เพื่อป้องกันกรณีผู้ใช้เซ็นคำสั่งล่วงหน้า (Pre-signing commands) แล้วมีคนดักข้อมูลไปรันในอนาคต:
- **ข้อความระดับ Payload** จะอยู่ในโครงสร้าง: `{ "data": ..., "timestamp": ..., "sig": ... }`
- ลายเซ็น `sig` จะคำนวณจาก `payload + topic + timestamp` ร่วมกัน
- ผู้รับ (Subscriber) จะประเมินและถอดลายเซ็นเพื่อตรวจสอบเวลาและเนื้อหาทันทีก่อนประมวลผลคำสั่ง

---

## 4. แผนการนำไปใช้งานจริง (Target Stack)

1. **MQTT Broker**: **EMQX (v5.x)**
   - ใช้โมดูลตรวจสอบความถูกต้องมาตรฐาน (HTTP Authentication/Authorization Plugin) เชื่อมต่อไปยัง Webhook API
   - รองรับการทำ **Native Clustering** (Mnesia/Erlang) ในระดับอุตสาหกรรม
2. **Auth Webhook Server**: พัฒนาด้วย **Node.js/Bun**
   - ใช้ไลบรารี **Viem** หรือ **Ethers.js** ในการทำ Signature Recovery
   - ทำงานได้รวดเร็วและเป็นแบบไร้สถานะ (Stateless)
3. **Bridge Support (Hybrid Gate Architecture)**:
   - เนื่องจากระบบ MQTT Bridge (เช่น Mosquitto Bridge บน Edge Device) มีข้อจำกัดไม่สามารถสร้างลายเซ็น SIWE ใหม่แบบไดนามิกตอนเชื่อมต่อได้
   - **ARRA-MQ** จะใช้การแยกพอร์ตการเชื่อมต่อ:
     - **Port 1883/8883 (SIWE Port)**: เปิดให้ Client ทั่วไปเชื่อมต่อด้วย dynamic signature
     - **Port 18883 (Bridge/MTLS Port)**: เปิดให้สำหรับ Edge Bridge เชื่อมต่อด้วย Static Client Certificates (MTLS) หรือ JWT ระยะยาว พร้อมตีกรอบ ACL จำกัดหัวข้อเฉพาะภายใต้ prefix `bridge/#` เท่านั้น

---
🤖 *No.6 Gemini จาก ai-core [Context: ~80%]*
