const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

// ---------- App / Server / Socket setup ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Database ----------
const fs = require('fs');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'latecomer.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    admission_no   TEXT PRIMARY KEY,
    roll_number    TEXT,
    student_name   TEXT NOT NULL,
    class          TEXT
  );

  CREATE TABLE IF NOT EXISTS scans (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    admission_no   TEXT NOT NULL,
    roll_number    TEXT,
    student_name   TEXT NOT NULL,
    class          TEXT,
    scanned_by     TEXT,
    scanned_at     TEXT NOT NULL,
    scan_date      TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_scans_date ON scans(scan_date);
`);

// ---------- Multer (in-memory upload for the Excel master sheet) ----------
const upload = multer({ storage: multer.memoryStorage() });

// Normalize a 4-digit admission number: trims, strips non-digits, left-pads to 4.
function normalizeAdmissionNo(value) {
  if (value === null || value === undefined) return '';
  const digits = String(value).trim().replace(/\D/g, '');
  if (!digits) return '';
  return digits.padStart(4, '0').slice(-4);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (server local via ISO/UTC)
}

// ---------- API: Upload / process master Excel sheet ----------
app.post('/api/upload-master', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) return res.status(400).json({ error: 'Sheet appears to be empty' });

    // Flexible header matching (case/space insensitive) since Excel headers
    // are exactly: Roll number, Student name, Class, Admission NO
    const findKey = (row, candidates) => {
      const keys = Object.keys(row);
      for (const cand of candidates) {
        const hit = keys.find(k => k.trim().toLowerCase() === cand.toLowerCase());
        if (hit) return hit;
      }
      return null;
    };

    const sample = rows[0];
    const rollKey = findKey(sample, ['Roll number', 'Roll Number', 'Roll No', 'RollNumber']);
    const nameKey = findKey(sample, ['Student name', 'Student Name', 'Name']);
    const classKey = findKey(sample, ['Class']);
    const admissionKey = findKey(sample, ['Admission NO', 'Admission No', 'Admission Number', 'AdmissionNO']);

    if (!nameKey || !admissionKey) {
      return res.status(400).json({
        error: 'Could not find required columns. Expected: Roll number, Student name, Class, Admission NO',
        foundColumns: Object.keys(sample)
      });
    }

    const insert = db.prepare(`
      INSERT INTO students (admission_no, roll_number, student_name, class)
      VALUES (@admission_no, @roll_number, @student_name, @class)
      ON CONFLICT(admission_no) DO UPDATE SET
        roll_number = excluded.roll_number,
        student_name = excluded.student_name,
        class = excluded.class
    `);

    let imported = 0;
    let skipped = 0;
    const skippedRows = [];

    const insertMany = db.transaction((records) => {
      for (const r of records) {
        const admissionNo = normalizeAdmissionNo(r[admissionKey]);
        const studentName = String(r[nameKey] || '').trim();
        if (!admissionNo || !studentName) {
          skipped++;
          skippedRows.push(r);
          continue;
        }
        insert.run({
          admission_no: admissionNo,
          roll_number: classKey ? String(r[rollKey] || '').trim() : String(r[rollKey] || '').trim(),
          student_name: studentName,
          class: classKey ? String(r[classKey] || '').trim() : ''
        });
        imported++;
      }
    });

    insertMany(rows);

    const totalStudents = db.prepare('SELECT COUNT(*) AS c FROM students').get().c;

    res.json({
      success: true,
      imported,
      skipped,
      totalStudents,
      message: `Imported/updated ${imported} students. ${skipped} rows skipped (missing name or admission no).`
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to process file', details: err.message });
  }
});

// ---------- API: current master-list status ----------
app.get('/api/students/count', (req, res) => {
  const row = db.prepare('SELECT COUNT(*) AS c FROM students').get();
  res.json({ totalStudents: row.c });
});

app.get('/api/students', (req, res) => {
  const rows = db.prepare('SELECT * FROM students ORDER BY class, roll_number').all();
  res.json(rows);
});

// ---------- API: instant lookup by admission number (used by scanner) ----------
app.get('/api/student/:admissionNo', (req, res) => {
  const admissionNo = normalizeAdmissionNo(req.params.admissionNo);
  if (!admissionNo) return res.status(400).json({ error: 'Invalid admission number' });

  const student = db.prepare('SELECT * FROM students WHERE admission_no = ?').get(admissionNo);
  if (!student) {
    return res.status(404).json({ error: 'Student not found', admission_no: admissionNo });
  }
  res.json(student);
});

// ---------- API: record a verified scan (teacher clicked "Verified") ----------
app.post('/api/verify', (req, res) => {
  try {
    const { admission_no, scanned_by } = req.body;
    const admissionNo = normalizeAdmissionNo(admission_no);
    if (!admissionNo) return res.status(400).json({ error: 'admission_no is required' });

    const student = db.prepare('SELECT * FROM students WHERE admission_no = ?').get(admissionNo);
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const now = new Date();
    const scanned_at = now.toISOString();

    const info = db.prepare(`
      INSERT INTO scans (admission_no, roll_number, student_name, class, scanned_by, scanned_at, scan_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      student.admission_no,
      student.roll_number,
      student.student_name,
      student.class,
      scanned_by || 'Unknown',
      scanned_at,
      todayStr()
    );

    const record = {
      id: info.lastInsertRowid,
      admission_no: student.admission_no,
      roll_number: student.roll_number,
      student_name: student.student_name,
      class: student.class,
      scanned_by: scanned_by || 'Unknown',
      scanned_at
    };

    // Push instantly to every connected Admin dashboard
    io.emit('new-scan', record);

    res.json({ success: true, record });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: 'Failed to record scan', details: err.message });
  }
});

// ---------- API: fetch today's scans (Admin dashboard initial load) ----------
app.get('/api/scans', (req, res) => {
  const date = req.query.date || todayStr();
  const rows = db.prepare('SELECT * FROM scans WHERE scan_date = ? ORDER BY id DESC').all(date);
  res.json(rows);
});

// ---------- API: clear today's scans (start of a new day) ----------
app.delete('/api/scans', (req, res) => {
  const date = req.query.date || todayStr();
  const info = db.prepare('DELETE FROM scans WHERE scan_date = ?').run(date);
  io.emit('scans-cleared', { date });
  res.json({ success: true, deleted: info.changes });
});

// ---------- API: CSV export of today's (or a given date's) scans ----------
app.get('/api/scans/export', (req, res) => {
  const date = req.query.date || todayStr();
  const rows = db.prepare('SELECT * FROM scans WHERE scan_date = ? ORDER BY scanned_at ASC').all(date);

  const header = 'Roll Number,Student Name,Class,Admission No,Scanned By,Time\n';
  const body = rows.map(r => {
    const time = new Date(r.scanned_at).toLocaleString();
    return [r.roll_number, r.student_name, r.class, r.admission_no, r.scanned_by, time]
      .map(v => `"${String(v || '').replace(/"/g, '""')}"`)
      .join(',');
  }).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="latecomers-${date}.csv"`);
  res.send(header + body);
});

// ---------- Socket.IO connection log ----------
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// ---------- Page routes ----------
app.get('/', (req, res) => res.redirect('/scanner.html'));

server.listen(PORT, () => {
  console.log(`\n Latecomer Scanning System running on http://localhost:${PORT}`);
  console.log(`   Scanner:  http://localhost:${PORT}/scanner.html`);
  console.log(`   Admin:    http://localhost:${PORT}/admin.html\n`);
});
