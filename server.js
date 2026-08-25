const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const TZ = 'Asia/Kolkata';

// ---------- App / Server / Socket setup ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Database (Postgres via DATABASE_URL env var) ----------
if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL environment variable. Set it in Render > Environment.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // required for Supabase/most hosted Postgres
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      admission_no   TEXT PRIMARY KEY,
      roll_number    TEXT,
      student_name   TEXT NOT NULL,
      class          TEXT
    );

    CREATE TABLE IF NOT EXISTS scans (
      id             SERIAL PRIMARY KEY,
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
  console.log('Database ready.');
}

// ---------- Multer (in-memory upload for the Excel master sheet) ----------
const upload = multer({ storage: multer.memoryStorage() });

// Normalize a 4-digit admission number: trims, strips non-digits, left-pads to 4.
function normalizeAdmissionNo(value) {
  if (value === null || value === undefined) return '';
  const digits = String(value).trim().replace(/\D/g, '');
  if (!digits) return '';
  return digits.padStart(4, '0').slice(-4);
}

// "Today" in IST (school's actual local date), not UTC.
function todayStr() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`; // YYYY-MM-DD
}

// Format an ISO timestamp as a readable IST time string, for CSV export.
function formatIST(isoString) {
  return new Date(isoString).toLocaleString('en-IN', {
    timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
  });
}

// ---------- API: Upload / process master Excel sheet ----------
app.post('/api/upload-master', upload.single('file'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) return res.status(400).json({ error: 'Sheet appears to be empty' });

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

    let imported = 0;
    let skipped = 0;

    await client.query('BEGIN');

    for (const r of rows) {
      const admissionNo = normalizeAdmissionNo(r[admissionKey]);
      const studentName = String(r[nameKey] || '').trim();
      if (!admissionNo || !studentName) {
        skipped++;
        continue;
      }
      const rollNumber = rollKey ? String(r[rollKey] || '').trim() : '';
      const className = classKey ? String(r[classKey] || '').trim() : '';

      await client.query(
        `INSERT INTO students (admission_no, roll_number, student_name, class)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (admission_no) DO UPDATE SET
           roll_number = EXCLUDED.roll_number,
           student_name = EXCLUDED.student_name,
           class = EXCLUDED.class`,
        [admissionNo, rollNumber, studentName, className]
      );
      imported++;
    }

    await client.query('COMMIT');

    const { rows: countRows } = await pool.query('SELECT COUNT(*) AS c FROM students');
    const totalStudents = parseInt(countRows[0].c, 10);

    res.json({
      success: true,
      imported,
      skipped,
      totalStudents,
      message: `Imported/updated ${imported} students. ${skipped} rows skipped (missing name or admission no).`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to process file', details: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/students/count', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS c FROM students');
    res.json({ totalStudents: parseInt(rows[0].c, 10) });
  } catch (err) {
    console.error('Count error:', err);
    res.status(500).json({ error: 'Failed to get count' });
  }
});

app.get('/api/students', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM students ORDER BY class, roll_number');
    res.json(rows);
  } catch (err) {
    console.error('Students fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

app.get('/api/student/:admissionNo', async (req, res) => {
  try {
    const admissionNo = normalizeAdmissionNo(req.params.admissionNo);
    if (!admissionNo) return res.status(400).json({ error: 'Invalid admission number' });

    const { rows } = await pool.query('SELECT * FROM students WHERE admission_no = $1', [admissionNo]);
    const student = rows[0];
    if (!student) {
      return res.status(404).json({ error: 'Student not found', admission_no: admissionNo });
    }
    res.json(student);
  } catch (err) {
    console.error('Lookup error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

app.post('/api/verify', async (req, res) => {
  try {
    const { admission_no, scanned_by } = req.body;
    const admissionNo = normalizeAdmissionNo(admission_no);
    if (!admissionNo) return res.status(400).json({ error: 'admission_no is required' });

    const { rows: studentRows } = await pool.query('SELECT * FROM students WHERE admission_no = $1', [admissionNo]);
    const student = studentRows[0];
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const now = new Date();
    const scanned_at = now.toISOString();

    const { rows: insertRows } = await pool.query(
      `INSERT INTO scans (admission_no, roll_number, student_name, class, scanned_by, scanned_at, scan_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        student.admission_no,
        student.roll_number,
        student.student_name,
        student.class,
        scanned_by || 'Unknown',
        scanned_at,
        todayStr()
      ]
    );

    const record = {
      id: insertRows[0].id,
      admission_no: student.admission_no,
      roll_number: student.roll_number,
      student_name: student.student_name,
      class: student.class,
      scanned_by: scanned_by || 'Unknown',
      scanned_at
    };

    io.emit('new-scan', record);

    res.json({ success: true, record });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: 'Failed to record scan', details: err.message });
  }
});

// Chronological order (earliest first) so Admin table and CSV export always match.
app.get('/api/scans', async (req, res) => {
  try {
    const date = req.query.date || todayStr();
    const { rows } = await pool.query('SELECT * FROM scans WHERE scan_date = $1 ORDER BY scanned_at ASC', [date]);
    res.json(rows);
  } catch (err) {
    console.error('Scans fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch scans' });
  }
});

app.delete('/api/scans', async (req, res) => {
  try {
    const date = req.query.date || todayStr();
    const result = await pool.query('DELETE FROM scans WHERE scan_date = $1', [date]);
    io.emit('scans-cleared', { date });
    res.json({ success: true, deleted: result.rowCount });
  } catch (err) {
    console.error('Clear error:', err);
    res.status(500).json({ error: 'Failed to clear scans' });
  }
});

app.get('/api/scans/export', async (req, res) => {
  try {
    const date = req.query.date || todayStr();
    const { rows } = await pool.query('SELECT * FROM scans WHERE scan_date = $1 ORDER BY scanned_at ASC', [date]);

    const header = 'Roll Number,Student Name,Class,Admission No,Scanned By,Time (IST)\n';
    const body = rows.map(r => {
      const time = formatIST(r.scanned_at);
      return [r.roll_number, r.student_name, r.class, r.admission_no, r.scanned_by, time]
        .map(v => `"${String(v || '').replace(/"/g, '""')}"`)
        .join(',');
    }).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="latecomers-${date}.csv"`);
    res.send(header + body);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Failed to export' });
  }
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

app.get('/', (req, res) => res.redirect('/scanner.html'));

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`\n Latecomer Scanning System running on http://localhost:${PORT}`);
      console.log(`   Scanner:  http://localhost:${PORT}/scanner.html`);
      console.log(`   Admin:    http://localhost:${PORT}/admin.html\n`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
