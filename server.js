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
      date TEXT NOT NULL DEFAULT '',
      start_time TEXT NOT NULL DEFAULT '',
      end_time TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      map_url TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Allow date/start_time to be empty for events (existing rows ok)
  await pool.query(`ALTER TABLE entries ALTER COLUMN date DROP NOT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE entries ALTER COLUMN start_time DROP NOT NULL`).catch(() => {});

  // Event slots (candidate dates for events)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_slots (
      id SERIAL PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_slots_entry ON event_slots(entry_id, sort_order)`);

  // Responses table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS responses (
      id SERIAL PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      voter_id TEXT NOT NULL,
      voter_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('参加','不参加','未定')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Add slot_id column for event responses
  await pool.query(`ALTER TABLE responses ADD COLUMN IF NOT EXISTS slot_id INTEGER REFERENCES event_slots(id) ON DELETE CASCADE`);
  // Drop legacy unique constraint if it exists
  await pool.query(`ALTER TABLE responses DROP CONSTRAINT IF EXISTS responses_entry_id_voter_id_key`).catch(() => {});
  // Partial unique indexes: one per (entry, voter) for sites; one per (slot, voter) for events
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_site_resp ON responses(entry_id, voter_id) WHERE slot_id IS NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_event_resp ON responses(slot_id, voter_id) WHERE slot_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_responses_entry ON responses(entry_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_entries_type_date ON entries(type, date)`);
}

const VALID_TYPES = new Set(['site', 'event']);
const VALID_STATUSES = new Set(['参加', '不参加', '未定']);
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TIME = /^\d{2}:\d{2}$/;

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function validateSlot(s) {
  const date = String(s?.date || '').trim();
  const start_time = String(s?.start_time || '').trim();
  const end_time = String(s?.end_time || '').trim();
  if (!RE_DATE.test(date)) return null;
  if (!RE_TIME.test(start_time)) return null;
  if (end_time && !RE_TIME.test(end_time)) return null;
  return { date, start_time, end_time };
}

function validateEntry(body) {
  const type = String(body?.type || '').trim();
  const title = String(body?.title || '').trim();
  const details = String(body?.details || '').trim();
  const map_url_raw = String(body?.map_url || '').trim();

  if (!VALID_TYPES.has(type)) return { error: '種別が不正です' };
  if (!title) return { error: 'タイトルを入力してください' };

  let map_url = '';
  if (map_url_raw) {
    if (!/^https?:\/\//i.test(map_url_raw)) return { error: '地図URLは http(s) で始めてください' };
    map_url = map_url_raw.slice(0, 500);
  }

  const out = {
    type,
    title: title.slice(0, 100),
    details: details.slice(0, 500),
    map_url,
  };

  if (type === 'site') {
    const date = String(body?.date || '').trim();
    const start_time = String(body?.start_time || '').trim();
    const end_time = String(body?.end_time || '').trim();
    if (!RE_DATE.test(date)) return { error: '日付の形式が不正です' };
    if (!RE_TIME.test(start_time)) return { error: '開始時刻の形式が不正です' };
    if (end_time && !RE_TIME.test(end_time)) return { error: '終了時刻の形式が不正です' };
    out.date = date;
    out.start_time = start_time;
    out.end_time = end_time;
    out.slots = [];
  } else {
    // event: requires slots
    const slots = Array.isArray(body?.slots) ? body.slots : [];
    if (slots.length === 0) return { error: '候補日時を1つ以上追加してください' };
    if (slots.length > 30) return { error: '候補日時は30件までです' };
    const cleanSlots = [];
    for (const s of slots) {
      const v = validateSlot(s);
      if (!v) return { error: '候補日時に不正な入力があります' };
      cleanSlots.push(v);
    }
    out.date = '';
    out.start_time = '';
    out.end_time = '';
    out.slots = cleanSlots;
  }
  return { ok: out };
}

app.get('/api/entries', async (req, res, next) => {
  try {
    const type = req.query.type;
    if (!VALID_TYPES.has(type)) return res.status(400).json({ error: 'invalid type' });

    const entriesRes = await pool.query(`
      SELECT id, type, title, date, start_time, end_time, details, map_url
      FROM entries
      WHERE type = $1
      ORDER BY (CASE WHEN date = '' THEN 1 ELSE 0 END), date, start_time, id
    `, [type]);
    const entries = entriesRes.rows;
    if (entries.length === 0) return res.json({ entries: [] });

    const ids = entries.map(e => e.id);
    const slotsRes = await pool.query(
      `SELECT id, entry_id, date, start_time, end_time, sort_order FROM event_slots WHERE entry_id = ANY($1::int[]) ORDER BY entry_id, sort_order, id`,
      [ids]
    );
    const respRes = await pool.query(
      `SELECT entry_id, slot_id, voter_id, voter_name, status FROM responses WHERE entry_id = ANY($1::int[])`,
      [ids]
    );

    const slotMap = new Map();
    for (const s of slotsRes.rows) {
      if (!slotMap.has(s.entry_id)) slotMap.set(s.entry_id, []);
      slotMap.get(s.entry_id).push(s);
    }
    const respByEntry = new Map();
    const respBySlot = new Map();
    for (const r of respRes.rows) {
      if (r.slot_id == null) {
        if (!respByEntry.has(r.entry_id)) respByEntry.set(r.entry_id, []);
        respByEntry.get(r.entry_id).push({ voter_id: r.voter_id, voter_name: r.voter_name, status: r.status });
      } else {
        if (!respBySlot.has(r.slot_id)) respBySlot.set(r.slot_id, []);
        respBySlot.get(r.slot_id).push({ voter_id: r.voter_id, voter_name: r.voter_name, status: r.status });
      }
    }

    for (const e of entries) {
      if (e.type === 'site') {
        e.responses = respByEntry.get(e.id) || [];
        e.slots = [];
      } else {
        const slots = slotMap.get(e.id) || [];
        for (const s of slots) {
          s.responses = respBySlot.get(s.id) || [];
        }
        e.slots = slots;
        e.responses = [];
      }
    }

    res.json({ entries });
  } catch (e) { next(e); }
});

app.post('/api/entries', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const v = validateEntry(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const { type, title, date, start_time, end_time, details, map_url, slots } = v.ok;

    await client.query('BEGIN');
    const ins = await client.query(`
      INSERT INTO entries (type, title, date, start_time, end_time, details, map_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [type, title, date, start_time, end_time, details, map_url]);
    const id = ins.rows[0].id;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      await client.query(`
        INSERT INTO event_slots (entry_id, date, start_time, end_time, sort_order)
        VALUES ($1, $2, $3, $4, $5)
      `, [id, s.date, s.start_time, s.end_time, i]);
    }
    await client.query('COMMIT');
    res.json({ id });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

app.put('/api/entries/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const v = validateEntry(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const { type, title, date, start_time, end_time, details, map_url, slots } = v.ok;

    await client.query('BEGIN');
    const upd = await client.query(`
      UPDATE entries SET title = $1, date = $2, start_time = $3, end_time = $4, details = $5, map_url = $6
      WHERE id = $7 AND type = $8
    `, [title, date, start_time, end_time, details, map_url, id, type]);
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found or type mismatch' });
    }

    if (type === 'event') {
      // Replace slots: try to keep existing slot ids by date+time match to preserve responses
      const existing = await client.query('SELECT id, date, start_time, end_time FROM event_slots WHERE entry_id = $1', [id]);
      const existingMap = new Map();
      for (const s of existing.rows) {
        existingMap.set(`${s.date}|${s.start_time}|${s.end_time}`, s.id);
      }
      const keepIds = new Set();
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        const key = `${s.date}|${s.start_time}|${s.end_time}`;
        if (existingMap.has(key)) {
          const sid = existingMap.get(key);
          await client.query('UPDATE event_slots SET sort_order = $1 WHERE id = $2', [i, sid]);
          keepIds.add(sid);
        } else {
          const r = await client.query(`
            INSERT INTO event_slots (entry_id, date, start_time, end_time, sort_order)
            VALUES ($1, $2, $3, $4, $5) RETURNING id
          `, [id, s.date, s.start_time, s.end_time, i]);
          keepIds.add(r.rows[0].id);
        }
      }
      // Delete slots not in new list
      const toDelete = existing.rows.map(r => r.id).filter(sid => !keepIds.has(sid));
      if (toDelete.length > 0) {
        await client.query('DELETE FROM event_slots WHERE id = ANY($1::int[])', [toDelete]);
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

app.delete('/api/entries/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const result = await pool.query('DELETE FROM entries WHERE id = $1', [id]);
    res.json({ ok: result.rowCount > 0 });
  } catch (e) { next(e); }
});

// Site-level response (no slot)
app.put('/api/entries/:id/response', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const voter_id = String(req.body?.voter_id || '').trim().slice(0, 64);
    const status = req.body?.status;
    if (!voter_id) return res.status(400).json({ error: 'voter_id required' });
    if (!VALID_STATUSES.has(status)) return res.status(400).json({ error: 'invalid status' });

    const entry = await pool.query('SELECT type FROM entries WHERE id = $1', [id]);
    if (entry.rowCount === 0) return res.status(404).json({ error: 'not found' });
    if (entry.rows[0].type !== 'site') {
      return res.status(400).json({ error: 'このエンドポイントは現場専用です' });
    }

    await pool.query(`
      INSERT INTO responses (entry_id, voter_id, voter_name, status, updated_at)
      VALUES ($1, $2, '', $3, NOW())
      ON CONFLICT (entry_id, voter_id) WHERE slot_id IS NULL DO UPDATE
      SET status = EXCLUDED.status, updated_at = NOW()
    `, [id, voter_id, status]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.delete('/api/entries/:id/response', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const voter_id = String(req.body?.voter_id || '').trim();
    if (!voter_id) return res.status(400).json({ error: 'voter_id required' });
    await pool.query('DELETE FROM responses WHERE entry_id = $1 AND voter_id = $2 AND slot_id IS NULL', [id, voter_id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Slot-level response (events)
app.put('/api/entries/:id/slots/:slotId/response', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const slotId = parseInt(req.params.slotId, 10);
    if (!Number.isInteger(id) || !Number.isInteger(slotId)) return res.status(400).json({ error: 'invalid id' });
    const voter_id = String(req.body?.voter_id || '').trim().slice(0, 64);
    const voter_name = String(req.body?.voter_name || '').trim().slice(0, 50);
    const status = req.body?.status;
    if (!voter_id) return res.status(400).json({ error: 'voter_id required' });
    if (!voter_name) return res.status(400).json({ error: '名前を入力してください' });
    if (!VALID_STATUSES.has(status)) return res.status(400).json({ error: 'invalid status' });

    const slot = await pool.query('SELECT entry_id FROM event_slots WHERE id = $1 AND entry_id = $2', [slotId, id]);
    if (slot.rowCount === 0) return res.status(404).json({ error: 'slot not found' });

    await pool.query(`
      INSERT INTO responses (entry_id, slot_id, voter_id, voter_name, status, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (slot_id, voter_id) WHERE slot_id IS NOT NULL DO UPDATE
      SET voter_name = EXCLUDED.voter_name, status = EXCLUDED.status, updated_at = NOW()
    `, [id, slotId, voter_id, voter_name, status]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.delete('/api/entries/:id/slots/:slotId/response', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const slotId = parseInt(req.params.slotId, 10);
    if (!Number.isInteger(id) || !Number.isInteger(slotId)) return res.status(400).json({ error: 'invalid id' });
    const voter_id = String(req.body?.voter_id || '').trim();
    if (!voter_id) return res.status(400).json({ error: 'voter_id required' });
    await pool.query('DELETE FROM responses WHERE slot_id = $1 AND voter_id = $2', [slotId, voter_id]);
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
