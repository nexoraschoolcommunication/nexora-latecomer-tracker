# Latecomer Scanning System

Two web apps + one shared backend:

- **Scanner Website** — `public/scanner.html` — mobile camera barcode scanner for teachers at the gate.
- **Admin Website** — `public/admin.html` — upload the master list, watch a live dashboard of latecomers.
- **Backend** — `server.js` — Express + Socket.IO + SQLite. Both pages are served by the same server and talk to it over REST + WebSockets, so a verified scan appears on the Admin dashboard within a fraction of a second.

## 1. Install & Run

Requires Node.js 18+.

```bash
cd latecomer-system
npm install
npm start
```

You'll see:

```
Latecomer Scanning System running on http://localhost:3000
   Scanner:  http://localhost:3000/scanner.html
   Admin:    http://localhost:3000/admin.html
```

- On the **same computer/network**, open the Admin URL on a laptop, and the Scanner URL on a teacher's phone (use the machine's LAN IP instead of `localhost`, e.g. `http://192.168.1.20:3000/scanner.html`).
- Camera access requires **HTTPS or localhost** in most mobile browsers. For real-world use over Wi-Fi, deploy behind HTTPS (see "Deploying" below) or use a tool like `ngrok` for testing:
  ```bash
  npx ngrok http 3000
  ```
  then open the printed `https://...` URL on the phone.

## 2. Load the master student list

1. Open the **Admin** page.
2. Under "Master List Upload", choose your Excel file (`.xlsx`) with columns:
   `Roll number`, `Student name`, `Class`, `Admission NO`.
3. Click **Upload & Process**. The 4-digit `Admission NO` is normalized (left-padded to 4 digits) and stored as the lookup key. Re-uploading the same file updates existing students rather than duplicating them.

## 3. How scanning works

1. Teacher opens the **Scanner** page on their phone, optionally types their name/gate at the top (remembered for next time).
2. Camera opens automatically and scans continuously at high frame rate (20 fps, native `BarcodeDetector` used when the phone supports it — falls back to a JS decoder otherwise).
3. On a successful read, the app extracts the last 4 digits from the barcode, looks the student up instantly (`GET /api/student/:admissionNo`), and shows a bottom sheet with Name / Class / Roll No / Admission No.
4. Nothing is sent yet. The teacher taps **✓ Verified**, which:
   - Timestamps the moment (server time, ISO format),
   - Sends it to the backend (`POST /api/verify`),
   - The backend saves it and broadcasts it over Socket.IO to every open Admin dashboard — it appears in the table instantly, no refresh needed.
5. Tapping **Cancel** discards the read and resumes scanning.

## 4. Admin dashboard features

- **Live table** of today's latecomers (Name, Class, Roll No, Admission No, Time, who scanned them), updating in real time via WebSocket push.
- **Search** box to filter by name/class.
- **Export CSV** of today's records.
- **Clear Today** to reset the list (e.g. at the start of a new day) — old records stay in the database under their original date, only today's view is wiped.
- Stat cards: latecomers today, total students loaded, last scan time.

## 5. Project structure

```
latecomer-system/
├── server.js              # Express + Socket.IO + SQLite backend
├── package.json
├── data/                  # SQLite DB file lives here (auto-created)
├── public/
│   ├── scanner.html        # Teacher-facing scanner (mobile)
│   └── admin.html           # Admin dashboard
```

## 6. API reference (for reference / integration)

| Method | Route                     | Purpose                                      |
|--------|----------------------------|-----------------------------------------------|
| POST   | `/api/upload-master`       | Upload & parse the master Excel sheet         |
| GET    | `/api/students/count`      | Count of students currently loaded            |
| GET    | `/api/students`            | Full student list                             |
| GET    | `/api/student/:admissionNo`| Instant lookup by 4-digit admission number    |
| POST   | `/api/verify`               | Record a verified scan (body: `admission_no`, `scanned_by`) |
| GET    | `/api/scans?date=YYYY-MM-DD`| Get scans for a date (defaults to today)      |
| DELETE | `/api/scans?date=YYYY-MM-DD`| Clear scans for a date                        |
| GET    | `/api/scans/export?date=`   | Download CSV of a date's scans                |

Socket.IO events: `new-scan` (fired on every verified scan), `scans-cleared`.

## 7. Why it's fast

- Uses the browser's **native `BarcodeDetector` API** when available (Chrome on Android) via `html5-qrcode`'s `useBarCodeDetectorIfSupported` option — this is dramatically faster than the JS-only fallback decoder.
- Scans at **20 fps** with a **narrow scan box** tuned for 1D barcodes (less image area to analyze per frame = faster decode).
- Restricts `formatsToSupport` to the handful of barcode formats you actually use (CODE_128/39, EAN, UPC, QR) instead of trying every symbology, cutting decode time per frame further.
- Lookup is a single indexed SQLite query on the `admission_no` primary key — sub-millisecond.
- Socket.IO pushes the verified record to Admin dashboards immediately — no polling delay (a 30s poll also runs as a safety net in case a socket event is ever missed).

## 8. Deploying beyond localhost

Any Node host works (Render, Railway, a school's own server, a Raspberry Pi on the LAN, etc.). Two things to keep in mind:
- Serve over **HTTPS** (or plain HTTP over a private LAN reachable via `http://<ip>:3000` — some mobile browsers still allow camera access on a private/local network without HTTPS, but this varies; HTTPS is the safe choice).
- The SQLite file in `data/` is the entire database — back it up periodically if you want historical latecomer records preserved long-term.
