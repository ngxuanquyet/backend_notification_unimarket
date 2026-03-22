# UniMarket Notification Backend

Backend rieng de gui push notification chat ma khong can Firebase Cloud Functions/Blaze.

Thu muc `backend/` nay co the duoc tach ra thanh 1 repo GitHub rieng va deploy doc lap len Render.

## Chuc nang

- Xac thuc Firebase ID token tu app Android
- Kiem tra sender co thuoc conversation hay khong
- Lay FCM token cua nguoi nhan tu Firestore
- Gui push notification bang Firebase Admin SDK
- Tu dong xoa token loi

## Setup

1. Vao Firebase Console va tao service account key JSON
2. Dat file do thanh `backend/service-account.json`
3. Copy `.env.example` thanh `.env`
4. Cai package:
   `npm install`
5. Chay local:
   `npm run dev`

## Bien moi truong

- `PORT`: cong backend, mac dinh `8080`
- `FIREBASE_PROJECT_ID`: project Firebase cua ban
- `GOOGLE_APPLICATION_CREDENTIALS`: duong dan toi service account JSON
- `FIREBASE_SERVICE_ACCOUNT_JSON`: toan bo noi dung service account JSON tren 1 dong

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

Luu y:
- Render yeu cau app bind vao `0.0.0.0` va dung `PORT` env var, backend nay da ho tro san.
- Khong nen commit file `service-account.json` len GitHub public.

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
