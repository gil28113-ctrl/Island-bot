import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

const {
  IG_APP_SECRET,
  IG_VERIFY_TOKEN,
  IG_TOKEN,
  DATABASE_URL,
  PORT = 3000
} = process.env;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is missing');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const API = 'https://graph.instagram.com/v21.0';
const app = express();

const clean = (h) =>
  String(h || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^\w.]/g, '')
    .slice(0, 30);

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS residents (
      handle TEXT PRIMARY KEY,
      joined BIGINT NOT NULL,
      igsid TEXT UNIQUE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_codes (
      code TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      igsid TEXT,
      created_at BIGINT NOT NULL
    )
  `);

  // Import existing residents without deleting the old file
  if (fs.existsSync('./residents.json')) {
    try {
      const old = JSON.parse(
        fs.readFileSync('./residents.json', 'utf8')
      );

      for (const r of old) {
        if (!r.handle || !r.joined) continue;

        await pool.query(
          `INSERT INTO residents (handle, joined)
           VALUES ($1, $2)
           ON CONFLICT (handle) DO NOTHING`,
          [clean(r.handle), Number(r.joined)]
        );
      }

      console.log('Old residents imported');
    } catch (e) {
      console.error('Migration error:', e);
    }
  }

  console.log('Database ready');
}

async function sendDM(igsid, message) {
  const r = await fetch(`${API}/me/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${IG_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      recipient: { id: igsid },
      message: { text: message }
    })
  });

  if (!r.ok) {
    throw new Error(`Instagram DM failed: ${r.status}`);
  }
}

async function usernameOf(igsid) {
  const r = await fetch(
    `${API}/${igsid}?fields=username`,
    {
      headers: {
        Authorization: `Bearer ${IG_TOKEN}`
      }
    }
  );

  const data = await r.json();

  if (!r.ok || !data.username) {
    throw new Error('Could not get Instagram username');
  }

  return data.username.toLowerCase();
}

app.use(express.json({
  verify: (req, _res, buf) => {
    req.raw = buf;
  }
}));

app.get('/', (_req, res) =>
  res.sendFile(path.resolve('index.html'))
);

const page = (title, body) =>
  `<!doctype html><html lang="he" dir="rtl">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title}</title>
    <style>
      body {
        font-family: system-ui,Arial,sans-serif;
        max-width:640px;
        margin:24px auto;
        padding:0 16px;
        line-height:1.7
      }
    </style>
  </head>
  <body><h1>${title}</h1>${body}</body></html>`;

app.get('/privacy', (_req, res) =>
  res.type('html').send(page(
    'מדיניות פרטיות - האי של המוזרים',
    `
    <p>האי של המוזרים הוא משחק. כדי להצטרף אליו אנחנו מבקשים ממך לשלוח קוד בהודעה פרטית לחשבון האינסטגרם של המשחק (@strangeisland2026).</p>
    <p><b>איזה מידע אנחנו שומרים:</b> שם המשתמש שלך באינסטגרם ותאריך ההצטרפות בלבד.</p>
    <p><b>מחיקה:</b> אפשר לבקש מחיקה בכל עת דרך <a href="/data-deletion">הוראות מחיקת מידע</a>.</p>
    <p>ליצירת קשר: הודעה פרטית ל־@strangeisland2026.</p>
    `
  ))
);

app.get('/data-deletion', (_req, res) =>
  res.type('html').send(page(
    'מחיקת מידע - האי של המוזרים',
    `
    <p>כדי למחוק את המידע שלך מהאי, שלח הודעה פרטית עם המילה <b>מחק</b> לחשבון @strangeisland2026.</p>
    `
  ))
);

// Create a new verification code
app.post('/api/start', async (req, res) => {
  try {
    const handle = clean(req.body?.handle);

    if (!handle) {
      return res.status(400).json({ error: 'handle' });
    }

    const existing = await pool.query(
      'SELECT handle FROM residents WHERE handle = $1',
      [handle]
    );

    if (existing.rows.length) {
      return res.status(409).json({ error: 'taken' });
    }

    let code;

    do {
      code = `WEIRD-${crypto.randomInt(1000, 10000)}`;

      const found = await pool.query(
        'SELECT code FROM pending_codes WHERE code = $1',
        [code]
      );

      if (!found.rows.length) break;
      code = null;
    } while (!code);

    const now = Date.now();

    await pool.query(
      `INSERT INTO pending_codes
       (code, handle, expires_at, created_at)
       VALUES ($1, $2, $3, $4)`,
      [code, handle, now + 10 * 60 * 1000, now]
    );

    res.json({ code });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server' });
  }
});

// Check verification status
app.get('/api/status', async (req, res) => {
  try {
    const code = String(req.query.code || '');

    const result = await pool.query(
      `SELECT verified, expires_at
       FROM pending_codes WHERE code = $1`,
      [code]
    );

    const p = result.rows[0];

    res.json({
      verified: !!p?.verified,
      expired: !p || Number(p.expires_at) < Date.now()
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server' });
  }
});

// Everyone on the island
app.get('/api/residents', async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT handle, joined FROM residents ORDER BY joined ASC'
    );

    res.json(
      result.rows.map(r => ({
        handle: r.handle,
        joined: Number(r.joined)
      }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server' });
  }
});

// Meta webhook verification
app.get('/webhook', (req, res) => {
  if (
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === IG_VERIFY_TOKEN
  ) {
    return res.send(req.query['hub.challenge']);
  }

  res.sendStatus(403);
});

// Incoming Instagram messages
app.post('/webhook', (req, res) => {
  const sig = req.get('x-hub-signature-256') || '';

  if (!IG_APP_SECRET || !req.raw) {
    return res.sendStatus(500);
  }

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', IG_APP_SECRET)
      .update(req.raw)
      .digest('hex');

  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(
      Buffer.from(sig),
      Buffer.from(expected)
    )
  ) {
    console.log('Bad webhook signature');
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  (async () => {
    for (const entry of req.body.entry || []) {
      for (const ev of entry.messaging || []) {
        const message = ev.message?.text;

        if (!message || ev.message.is_echo) continue;

        const sender = ev.sender.id;

        try {
          if (/מחק|DELETE/i.test(message)) {
            const username = await usernameOf(sender);

            const result = await pool.query(
              'DELETE FROM residents WHERE handle = $1',
              [username]
            );

            if (result.rowCount) {
              await sendDM(sender, 'מחקתי אותך מהאי.');
            } else {
              await sendDM(sender, 'לא מצאתי אותך על האי.');
            }

            continue;
          }

          const match = message.toUpperCase().match(/WEIRD-\d{4}/);

          if (!match) {
            await sendDM(
              sender,
              'שלח לי את הקוד שקיבלת באתר, למשל WEIRD-1234'
            );
            continue;
          }

          const code = match[0];
          const username = await usernameOf(sender);

          const client = await pool.connect();

          try {
            await client.query('BEGIN');

            const result = await client.query(
              `SELECT * FROM pending_codes
               WHERE code = $1 FOR UPDATE`,
              [code]
            );

            const p = result.rows[0];

            if (!p || Number(p.expires_at) < Date.now()) {
              await client.query('ROLLBACK');
              await sendDM(
                sender,
                'הקוד לא תקף או שפג תוקפו. תבקש קוד חדש באתר.'
              );
              continue;
            }

            if (p.verified) {
              await client.query('ROLLBACK');
              await sendDM(sender, 'הקוד הזה כבר נוצל.');
              continue;
            }

            if (username !== p.handle) {
              await client.query('ROLLBACK');
              await sendDM(sender, 'הקוד הזה שייך למשתמש אחר.');
              continue;
            }

            await client.query(
              `INSERT INTO residents (handle, joined, igsid)
               VALUES ($1, $2, $3)`,
              [p.handle, Date.now(), sender]
            );

            await client.query(
              `UPDATE pending_codes
               SET verified = TRUE, igsid = $2
               WHERE code = $1`,
              [code, sender]
            );

            await client.query('COMMIT');

            await sendDM(
              sender,
              `קיבלתי, @${p.handle}! בונה לך בית על האי 🏝️`
            );

          } catch (e) {
            await client.query('ROLLBACK');
            throw e;
          } finally {
            client.release();
          }

        } catch (e) {
          console.error('Webhook error:', e);
        }
      }
    }
  })();
});

// Start only after database is ready
initDB()
  .then(() => {
    app.listen(PORT, () =>
      console.log(`Island bot on :${PORT}`)
    );
  })
  .catch(e => {
    console.error('Database startup failed:', e);
    process.exit(1);
  });
