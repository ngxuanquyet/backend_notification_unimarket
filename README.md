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

## Bien moi truong

- `PORT`: cong backend, mac dinh `8080`
- `FIREBASE_PROJECT_ID`: project Firebase cua ban
- `GOOGLE_APPLICATION_CREDENTIALS`: duong dan toi service account JSON
- `FIREBASE_SERVICE_ACCOUNT_JSON`: toan bo noi dung service account JSON tren 1 dong
- `SEPAY_WEBHOOK_API_KEY`: API Key ma SePay gui trong header `Authorization: Apikey ...`
- `SEPAY_WEBHOOK_SECRET_KEY`: secret key neu ban cau hinh SePay gui qua header `X-Secret-Key`

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

Luu y:
- Render yeu cau app bind vao `0.0.0.0` va dung `PORT` env var, backend nay da ho tro san.
- Khong nen commit file `service-account.json` len GitHub public.
- Neu dung SePay, nen cau hinh `Request Content Type = application/json`.
- Neu dung xac thuc `API Key`, backend se kiem tra header `Authorization: Apikey <SEPAY_WEBHOOK_API_KEY>`.
- Webhook SePay nen tra ve JSON co `success: true`; backend nay da tra theo dung quy uoc do.

## Tich hop SePay

1. Tren SePay, tao webhook URL:
   `https://<backend-domain>/webhooks/sepay`
2. Chon su kien `Co tien vao`
3. Chon `Request Content Type = application/json`
4. Neu chon xac thuc `API Key`, dat cung gia tri voi env `SEPAY_WEBHOOK_API_KEY`
5. Neu chon xac thuc secret key, dat cung gia tri voi env `SEPAY_WEBHOOK_SECRET_KEY`

Webhook SePay se gui payload JSON voi cac field nhu `id`, `accountNumber`, `content`, `code`, `transferAmount`, `transferType`, `description`. Backend se:

- luu raw transaction vao collection `paymentTransactions`
- co gang rut ra ma thanh toan dang `UM<orderId>` tu `code`, `content` hoac `description`
- neu tim thay order dang `WAITING_PAYMENT` va so tien/tai khoan khop, backend se doi order sang `WAITING_CONFIRMATION`

Neu app van poll mai, hay kiem tra:

- order co `transferContent` dung dang `UM<orderId>` hay khong
- noi dung chuyen khoan thuc te co chua ma do hay khong
- SePay webhook co goi thanh cong toi `/webhooks/sepay` hay khong
- collection `paymentTransactions` co doc `sepay_<transactionId>` vua tao hay khong

## Day backend len GitHub

Neu ban dang dung thu muc nay nhu 1 repo rieng:

```bash
cd backend
git init
git add .
git commit -m "Initial notification backend"
git branch -M main
git remote add origin <github-repo-url>
git push -u origin main
```

Truoc khi push, dam bao cac file nay KHONG bi commit:
- `.env`
- `service-account.json`
- `*firebase-adminsdk*.json`
- `node_modules/`

## Ket noi Android

Mac dinh app dang goi:

`http://10.0.2.2:8080/`

Gia tri nay phu hop khi:
- backend chay tren may tinh
- app chay bang Android Emulator

Neu ban test bang dien thoai that, doi `NOTIFICATION_SERVER_BASE_URL` trong `app/build.gradle.kts`
thanh IP LAN cua may tinh, vi du:

`http://192.168.1.10:8080/`
