# notetakingku

Aplikasi notetaking (notebook → section → note, markdown editor via Vditor) dengan
login Google dan penyimpanan data di Firebase (Auth + Firestore).

## Yang berubah dari versi sebelumnya

Sebelumnya `app.js` setengah migrasi: sudah meng-*import* Firebase tapi logic
sync-nya masih pakai Google Identity Services + Google Drive API (dan beberapa
variabel seperti `CLIENT_ID`/`DRIVE_SCOPE`/`CACHE_KEY` dipakai tanpa pernah
didefinisikan — ini yang bikin app-nya error saat dijalankan).

Sekarang:
- **Login** pakai Firebase Auth (`signInWithPopup` + `GoogleAuthProvider`).
  Sesi login otomatis persist lewat `onAuthStateChanged`, jadi tidak perlu klik
  sign-in ulang tiap buka halaman.
- **Penyimpanan data** pakai Firestore: satu dokumen per user di
  `notes/{uid}`, isinya seluruh state (notebooks/sections/notes) sebagai JSON,
  strukturnya mirip dengan pendekatan "satu file JSON" yang dipakai versi
  Drive sebelumnya.
- `index.html` sudah tidak memuat script `accounts.google.com/gsi/client`
  lagi karena tidak dipakai.

⚠️ **Catatan skala**: karena seluruh data user disimpan sebagai satu dokumen
Firestore, batas ukurannya 1 MB. Kalau kamu sering menempel gambar besar
(paste/upload gambar disimpan sebagai base64 langsung di isi note), ukurannya
bisa cepat membengkak. Untuk penggunaan pribadi/wajar ini masih aman, tapi
kalau nanti mau lebih scalable, pertimbangkan pindah gambar ke Firebase
Storage dan/atau pecah note jadi dokumen terpisah per note.

## Setup sekali di awal

1. **Aktifkan layanan di Firebase Console** (project `notetakingku`):
   - Authentication → Sign-in method → aktifkan **Google**.
   - Firestore Database → buat database (mode production).
   - Authentication → Settings → **Authorized domains** → tambahkan domain
     hosting kamu (mis. `notetakingku.web.app`, `notetakingku.firebaseapp.com`,
     dan domain custom kalau ada). Tanpa ini popup login Google akan ditolak.

2. **Install Firebase CLI** (kalau belum):
   ```bash
   npm install -g firebase-tools
   firebase login
   ```

3. **Deploy Firestore rules** (wajib, supaya user lain tidak bisa baca/tulis
   data user lain):
   ```bash
   firebase deploy --only firestore:rules
   ```

4. **Deploy hosting manual** (dari folder project ini):
   ```bash
   firebase deploy --only hosting
   ```
   Aplikasi akan tersedia di `https://notetakingku.web.app`.

## Auto-deploy dari GitHub (opsional)

Sudah disertakan `.github/workflows/firebase-hosting-deploy.yml` yang akan
deploy ke Hosting tiap ada push ke branch `main`. Supaya jalan, buat secret
`FIREBASE_SERVICE_ACCOUNT_NOTETAKINGKU` di repo GitHub kamu:

```bash
firebase init hosting:github
```

Perintah ini akan menuntunmu login ke GitHub, memilih repo, dan otomatis
membuat service account + menyimpannya sebagai secret dengan nama yang sesuai
(sesuaikan nama secret di workflow kalau CLI memberi nama berbeda).

## Menjalankan secara lokal

Karena `app.js` pakai ES module (`type="module"`), buka lewat local server,
bukan `file://` langsung:

```bash
npx serve .
# atau
firebase emulators:start --only hosting
```

## Struktur file

- `index.html`, `styles.css`, `app.js` — aplikasi utamanya.
- `firebase.json`, `.firebaserc` — konfigurasi Firebase Hosting.
- `firestore.rules` — aturan keamanan Firestore (satu user hanya bisa akses
  dokumennya sendiri).
- `.github/workflows/firebase-hosting-deploy.yml` — CI/CD ke Firebase Hosting.
