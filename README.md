# THAICOM 4

หน้าเว็บติดตามดาวเทียม พร้อม backend อ่าน MongoDB โดยตรง ไม่ใช้ API Token
ใช้ Node.js 20.19 ขึ้นไป

1. รัน `npm ci`
2. คัดลอก `.env.example` เป็น `.env` แล้วตั้ง `MONGODB_URI` หรือ `MONGODB_PASSWORD`
3. รัน `npm start` แล้วเปิด http://localhost:3002

ฐานข้อมูลเริ่มต้น: `NOSCD` / collection `page_data`
อัปเดตสดต้องใช้ MongoDB Atlas หรือ replica set
หลังแก้ `.env` ให้รีสตาร์ตเซิร์ฟเวอร์ และอย่านำรหัสผ่านขึ้น Git
