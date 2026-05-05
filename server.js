import express from 'express';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  console.error('Error: DATABASE_URL environment variable is required.');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('site', 'event')),
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      map_url TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS responses (
      id SERIAL PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      voter_id TEXT NOT NULL,
      voter_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('参加','不参加','未定')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (entry_id, voter_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_entries_type_date ON entries(type, date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_responses_entry ON responses(entry_id)`);
}

const VALID_TYPES = new Set(['site', 'event']);
const VALID_STATUSES = new Set(['参加', '不参加', '未定']);
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TIME = /^\d{2}:\d{2}$/;

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function validateEntry(body) {
  const type = String(body?.type || '').trim();
  const title = String(body?.title || '').trim();
  const date = String(body?.date || '').trim();
  const start_time = String(body?.start_time || '').trim();
  const end_time = String(body?.end_time || '').trim();
  const details = String(body?.details || '').trim();
  const map_url_raw = String(body?.map_url || '').trim();

  if (!VALID_TYPES.has(type)) return { error: '種別が不正です' };
  if (!title) return { error: 'タイトルを入力してください' };
  if (!RE_DATE.test(date)) return { error: '日付の形式が不正です' };
  if (!RE_TIME.test(start_time)) return { error: '開始時刻の形式が不正です' };
  if (end_time && !RE_TIME.test(end_time)) return { error: '終了時刻の形式が不正です' };

  let map_url = '';
  if (map_url_raw) {
    if (!/^https?:\/\//i.test(map_url_raw)) return { error: '地図URLは http(s) で始めてください' };
    map_url = map_url_raw.slice(0, 500);
  }

  return {
    ok: {
      type,
      title: title.slice(0, 100),
      date,
      start_time,
      end_time,
      details: details.slice(0, 500),
      map_url,
    }
  };
}

app.get('/api/entries', async (req, res, next) => {
  try {
    const type = req.query.type;
    if (!VALID_TYPES.has(type)) return res.status(400).json({ error: 'invalid type' });

    const entriesRes = await pool.query(`
      SELECT id, type, title, date, start_time, end_time, details, map_url
      FROM entries
      WHERE type = $1
      ORDER BY date, start_time, id
    `, [type]);

    const respRes = await pool.query(`
      SELECT r.entry_id, r.voter_id, r.voter_name, r.status
      FROM responses r
      JOIN entries e ON e.id = r.entry_id
      WHERE e.type = $1
    `, [type]);

    const respMap = new Map();
    for (const r of respRes.rows) {
      if (!respMap.has(r.entry_id)) respMap.set(r.entry_id, []);
      respMap.get(r.entry_id).push({
        voter_id: r.voter_id,
        voter_name: r.voter_name,
        status: r.status,
      });
    }

    for (const e of entriesRes.rows) {
      e.responses = respMap.get(e.id) || [];
    }

    res.json({ entries: entriesRes.rows });
  } catch (e) { next(e); }
});

app.post('/api/entries', async (req, res, next) => {
  try {
    const v = validateEntry(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const { type, title, date, start_time, end_time, details, map_url } = v.ok;
    const result = await pool.query(`
      INSERT INTO entries (type, title, date, start_time, end_time, details, map_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [type, title, date, start_time, end_time, details, map_url]);
    res.json({ id: result.rows[0].id });
  } catch (e) { next(e); }
});

app.put('/api/entries/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const v = validateEntry(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const { type, title, date, start_time, end_time, details, map_url } = v.ok;
    const result = await pool.query(`
      UPDATE entries SET type = $1, title = $2, date = $3, start_time = $4, end_time = $5, details = $6, map_url = $7
      WHERE id = $8
    `, [type, title, date, start_time, end_time, details, map_url, id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.delete('/api/entries/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const result = await pool.query('DELETE FROM entries WHERE id = $1', [id]);
    res.json({ ok: result.rowCount > 0 });
  } catch (e) { next(e); }
});

app.put('/api/entries/:id/response', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const voter_id = String(req.body?.voter_id || '').trim().slice(0, 64);
    const voter_name = String(req.body?.voter_name || '').trim().slice(0, 50);
    const status = req.body?.status;
    if (!voter_id) return res.status(400).json({ error: 'voter_id required' });
    if (!VALID_STATUSES.has(status)) return res.status(400).json({ error: 'invalid status' });

    const entry = await pool.query('SELECT type FROM entries WHERE id = $1', [id]);
    if (entry.rowCount === 0) return res.status(404).json({ error: 'not found' });
    if (entry.rows[0].type === 'event' && !voter_name) {
      return res.status(400).json({ error: 'イベントの回答には名前が必要です' });
    }

    await pool.query(`
      INSERT INTO responses (entry_id, voter_id, voter_name, status, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (entry_id, voter_id) DO UPDATE
      SET voter_name = EXCLUDED.voter_name, status = EXCLUDED.status, updated_at = NOW()
    `, [id, voter_id, voter_name, status]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.delete('/api/entries/:id/response', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const voter_id = String(req.body?.voter_id || '').trim();
    if (!voter_id) return res.status(400).json({ error: 'voter_id required' });
    await pool.query('DELETE FROM responses WHERE entry_id = $1 AND voter_id = $2', [id, voter_id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const PORT = process.env.PORT || 3000;
init().then(() => {
  app.listen(PORT, () => console.log(`CleanVibes 起動: ポート ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
