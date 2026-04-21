# UniMarket Notification Backend

Backend rieng de gui push notification chat ma khong can Firebase Cloud Functions/Blaze.

Thu muc `backend/` nay co the duoc tach ra thanh 1 repo GitHub rieng va deploy doc lap len Render.

## Chuc nang

- Xac thuc Firebase ID token tu app Android
- Kiem tra sender co thuoc conversation hay khong
- Lay FCM token cua nguoi nhan tu Firestore
- Gui push notification bang Firebase Admin SDK
- Tu dong xoa token loi
- Nhan webhook SePay va luu giao dich vao Firestore
- Tu dong doi soat giao dich SePay voi order dang `WAITING_PAYMENT`
- API admin lock/unlock/delete user cho web admin
- API OTP SMS voi Twilio Verify (`/auth/otp/send`, `/auth/otp/verify`)

## Architecture (Clean Architecture + MVC)

```text
src/
  domain/
    constants/
  application/
    usecases/
    services/
      modules/
      legacy/
  infrastructure/
    config/
    firebase/
  presentation/
    controllers/
    routes/
  app.js
  index.js
```

Responsibilities:
- `presentation/routes`: define endpoint map (`/orders/*`, `/admin/*`, `/webhooks/*`).
- `presentation/controllers`: HTTP adapter (req/res, status code, error mapping).
- `application/usecases`: orchestrate use-case calls.
- `application/services/modules`: service slices by business capability.
- `application/services/legacy`: legacy monolith retained for safe phase-1 migration.
- `infrastructure/*`: env and Firebase Admin initialization.

## Setup

1. Vao Firebase Console va tao service account key JSON
2. Dat file do thanh `backend/service-account.json`
3. Copy `.env.example` thanh `.env`
4. Cai package:
   `npm install`
5. Chay local:
   `npm run dev`

## Cap quyen admin/moderator cho user (server-side)

Flow dung:

1. Tao user bang Firebase Authentication (email/password).
2. Tu backend, gan custom claim cho user:

   ```bash
   npm run grant:admin -- --email admin@uni.com --role admin
   ```

   Hoac theo `uid`:

   ```bash
   npm run grant:admin -- --uid <firebase_uid> --role admin
   ```

3. Bat buoc user dang xuat va dang nhap lai de nhan token moi co claim.

Xoa role:

```bash
npm run grant:admin -- --email admin@uni.com --role admin --remove
```

## API quan tri user (cho web admin)

- `POST /admin/users/:uid/lock` body `{ "disabled": true|false }`
- `DELETE /admin/users/:uid`

Yeu cau:
- Header `Authorization: Bearer <Firebase ID token>`
- Token phai co custom claim `admin: true` hoac `moderator: true`

## Bien moi truong

- `PORT`: cong backend, mac dinh `8080`
- `FIREBASE_PROJECT_ID`: project Firebase cua ban
- `GOOGLE_APPLICATION_CREDENTIALS`: duong dan toi service account JSON
- `FIREBASE_SERVICE_ACCOUNT_JSON`: toan bo noi dung service account JSON tren 1 dong
- `SEPAY_WEBHOOK_API_KEY`: API Key ma SePay gui trong header `Authorization: Apikey ...`
- `SEPAY_WEBHOOK_SECRET_KEY`: secret key neu ban cau hinh SePay gui qua header `X-Secret-Key`
- `TWILIO_ACCOUNT_SID`: SID tai khoan Twilio (`AC...`)
- `TWILIO_AUTH_TOKEN`: Auth Token Twilio (secret)
- `TWILIO_VERIFY_SERVICE_SID`: Verify Service SID (`VA...`)

## API OTP SMS (Twilio Verify)

- `POST /auth/otp/send`
  - Body: `{ "phoneNumber": "+84901234567" }`
- `POST /auth/otp/verify`
  - Body: `{ "phoneNumber": "+84901234567", "code": "123456" }`

Luu y:
- `phoneNumber` bat buoc dung dinh dang E.164 (`+` + ma quoc gia + so dien thoai).
- Khong goi Twilio truc tiep tu app Android; app chi goi backend API nay.

## Deploy Render

Neu ban tach rieng `backend/` thanh 1 repo:

1. Chi push noi dung thu muc `backend/` len GitHub
2. Tao Web Service tren Render tu repo backend do
3. Render se tu nhan `render.yaml`, hoac ban co the nhap tay:
   `Build Command = npm install`
   `Start Command = npm start`
4. Them env vars:
   `FIREBASE_PROJECT_ID=unimarket-e2582`
   `FIREBASE_SERVICE_ACCOUNT_JSON=<noi dung file service account JSON tren 1 dong>`
5. Sau khi deploy xong, Render se cap URL public, vi du:
   `https://unimarket-notification-backend.onrender.com`
6. Doi `NOTIFICATION_SERVER_BASE_URL` trong app Android sang URL do
7. Cau hinh webhook SePay tro toi:
   `https://unimarket-notification-backend.onrender.com/webhooks/sepay`

## Ket noi Android

Mac dinh app dang goi:

`http://10.0.2.2:8080/`

Gia tri nay phu hop khi:
- backend chay tren may tinh
- app chay bang Android Emulator

Neu ban test bang dien thoai that, doi `NOTIFICATION_SERVER_BASE_URL` trong `app/build.gradle.kts`
thanh IP LAN cua may tinh, vi du:

`http://192.168.1.10:8080/`
