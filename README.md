# 💰 Cetak Duit — Dashboard

> **Multi-Account Bot Dashboard dengan Real-time Monitoring via SSE**

Dashboard real-time untuk monitoring bot multi-akun Cantor8. Menampilkan profit bersih, portfolio, rewards, dan status seluruh akun dalam satu tampilan.

![Dashboard Preview](https://img.shields.io/badge/Status-Live-10b981?style=for-the-badge&logo=statuspage&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?style=for-the-badge&logo=express&logoColor=white)

---

## ✨ Fitur

| Fitur | Deskripsi |
|-------|-----------|
| 📊 **Profit Bersih** | Kalkulasi otomatis net profit (Portfolio + Unclaimed - Modal) |
| ⚡ **SSE Realtime** | Update data instan dari bot (<100ms latency) |
| 💎 **Multi-Account** | Monitor ratusan akun sekaligus |
| 🎮 **Command Center** | Kirim perintah ke bot dari dashboard |
| 🔄 **Balance Refresh** | Request refresh saldo dari dashboard |
| 📱 **Responsive** | Tampilan optimal di desktop & mobile |
| 🔐 **API Key Auth** | Autentikasi push endpoint |
| 💰 **Modal Dinamis** | Set modal per wallet saat startup |

---

## 📦 Instalasi

### 1. Clone Repository

```bash
git clone https://github.com/AaBatok/dashboard
cd dashboard
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Konfigurasi Environment

Buat file `.env.production`:

```env
# Server port
PORT=3888

# API Key untuk autentikasi bot push
API_KEY=ganti-dengan-api-key-kamu

# VPS ID (identifikasi di dashboard)
VPS_ID=vps-1
```

### 4. Konfigurasi Bot

Edit `config.json` — bagian dashboard:

```json
{
    "dashboard": {
        "enabled": true,
        "url": "http://IP-VPS-KAMU:3888",
        "api_key": "sama-dengan-env",
        "vps_id": "vps-1",
        "push_interval_seconds": 30
    }
}
```

---

## 🚀 Menjalankan

```bash
node server.js
```

Saat pertama kali jalan, akan muncul prompt:

```
╔══════════════════════════════════════════════════╗
║       💰 CETAK DUIT — DASHBOARD SETUP            ║
╚══════════════════════════════════════════════════╝

Berapa modal CC per wallet? (default: 65): _
```

Masukkan jumlah modal CC per wallet kamu, lalu tekan Enter. Dashboard akan langsung aktif.

---

## 📊 Kalkulasi Profit Bersih

```
Portfolio USD  = (Total CC × Harga CC) + (Total USDCx × $1) + (Total CETH × Harga CETH)
Unclaimed USD  = Total Pending Reward × Harga CC
Modal USD      = Modal Per Wallet × Jumlah Wallet × Harga CC

★ PROFIT BERSIH = (Portfolio + Unclaimed) - Modal
```

---

## 🌐 API Endpoints

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| `GET` | `/` | Dashboard UI |
| `GET` | `/api/stream` | SSE real-time stream |
| `POST` | `/api/push` | Terima data dari bot |
| `GET` | `/api/data` | Get data terbaru (fallback polling) |
| `GET` | `/api/config` | Get konfigurasi (modal per wallet) |
| `GET` | `/api/history` | Get riwayat data (untuk charts) |
| `GET` | `/api/status` | Server status |
| `POST` | `/api/command` | Kirim command ke bot |
| `POST` | `/api/refresh` | Request balance refresh |

### Push Data dari Bot

```bash
curl -X POST http://IP:3888/api/push \
  -H "Content-Type: application/json" \
  -H "x-api-key: API_KEY_KAMU" \
  -d '{"accounts": [...], "prices": {"ccUsd": 0.15, "cethUsd": 1900}}'
```

---

## 📁 Struktur File

```
c8-dashboard/
├── public/
│   ├── index.html      # Dashboard frontend
│   ├── bg.png           # Background image
│   └── logo.png         # Logo branding
├── server.js            # Express server + SSE
├── config.json          # Bot configuration
├── indexweb.js          # Bot web module
├── package.json         # Dependencies
├── .env.production      # Environment variables (tidak di-push)
└── .gitignore
```

---

## 🔧 Tech Stack

- **Backend:** Node.js + Express
- **Realtime:** Server-Sent Events (SSE)
- **Frontend:** Vanilla HTML/CSS/JS
- **Font:** Inter + JetBrains Mono (Google Fonts)

---

## 📝 Catatan

- File `.env.production` **tidak** di-push ke GitHub (ada di `.gitignore`)
- Ubah `API_KEY` sebelum deploy ke production
- Modal per wallet di-set setiap kali server dijalankan
- Dashboard otomatis reconnect jika koneksi SSE terputus

---

## 📄 License

MIT License — Free to use and modify.

---

**Provided by Batok** 🦇
