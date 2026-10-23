import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { IG_APP_SECRET, IG_VERIFY_TOKEN, IG_TOKEN, PORT = 3000 } = process.env;
const API = 'https://graph.instagram.com/v21.0';
const DB = './residents.json';

const residents = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : [];
const pending = new Map(); // code -> { handle, exp, verified }
const save = () => fs.writeFileSync(DB, JSON.stringify(residents));
const clean = (h) => String(h || '').trim().replace(/^@/, '').toLowerCase().replace(/[^\w.]/g, '').slice(0, 30);

async function sendDM(igsid, text) {
  await fetch(`${API}/me/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${IG_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: igsid }, message: { text } }),
  });
}

async function usernameOf(igsid) {
  const r = await fetch(`${API}/${igsid}?fields=username`, { headers: { Authorization: `Bearer ${IG_TOKEN}` } });
  return ((await r.json()).username || '').toLowerCase();
}

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.raw = buf; } }));
app.get('/', (_req, res) => res.sendFile(path.resolve('index.html')));

const page = (title, body) => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,Arial,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;line-height:1.7}</style></head><body><h1>${title}</h1>${body}</body></html>`;

app.get('/privacy', (_req, res) => res.type('html').send(page('מדיניות פרטיות - האי של המוזרים', `
<p>האי של המוזרים הוא משחק. כדי להצטרף אליו אנחנו מבקשים ממך לשלוח קוד בהודעה פרטית לחשבון האינסטגרם של המשחק (@strangeisland2026).</p>
<p><b>איזה מידע אנחנו שומרים:</b> שם המשתמש שלך באינסטגרם ותאריך ההצטרפות בלבד. אנחנו לא שומרים את תוכן ההודעות, סיסמאות או מידע אישי אחר, ולא מוכרים או משתפים מידע עם אף גורם.</p>
<p><b>למה:</b> כדי להציג את הבית שלך על האי ולוודא שהכינוי שייך לך.</p>
<p><b>מחיקה:</b> אפשר לבקש מחיקה בכל עת, ראה <a href="/data-deletion">הוראות מחיקת מידע</a>.</p>
<p>ליצירת קשר: הודעה פרטית ל־@strangeisland2026.</p>
<hr><p dir="ltr">Island of the Weirdos stores only your Instagram username and join date to show your house on the map. We do not store message content or share data. To delete your data, see <a href="/data-deletion">data deletion</a>.</p>`)));

app.get('/data-deletion', (_req, res) => res.type('html').send(page('מחיקת מידע - האי של המוזרים', `
<p>כדי למחוק את המידע שלך מהאי, שלח הודעה פרטית עם המילה <b>מחק</b> מהחשבון שלך לחשבון @strangeisland2026. הבוט ימחק את שם המשתמש שלך ויאשר.</p>
<p dir="ltr">To delete your data, send the word "delete" as a direct message to @strangeisland2026 from your account. The bot will remove your username and confirm.</p>`)));

// 1) The page asks for a code for a handle
app.post('/api/start', (req, res) => {
  const handle = clean(req.body?.handle);
  if (!handle) return res.status(400).json({ error: 'handle' });
  if (residents.some((r) => r.handle === handle)) return res.status(409).json({ error: 'taken' });
  let code;
  do { code = `WEIRD-${crypto.randomInt(1000, 10000)}`; } while (pending.has(code));
  pending.set(code, { handle, exp: Date.now() + 10 * 60 * 1000, verified: false });
  res.json({ code });
});

// 2) The page polls until the bot has verified the DM
app.get('/api/status', (req, res) => {
  const p = pending.get(String(req.query.code || ''));
  res.json({ verified: !!p?.verified, expired: !p || p.exp < Date.now() });
});

// 3) Everyone on the island
app.get('/api/residents', (_req, res) => res.json(residents));

// Meta webhook verification
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === IG_VERIFY_TOKEN) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// Incoming Instagram DMs to the bot account
app.post('/webhook', (req, res) => {
  const sig = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', IG_APP_SECRET).update(req.raw).digest('hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    console.log('webhook: bad signature (check IG_APP_SECRET)');
    return res.sendStatus(401);
  }
  console.log('webhook: received', JSON.stringify(req.body).slice(0, 300));
  res.sendStatus(200);

  (async () => {
    for (const entry of req.body.entry || []) {
      for (const ev of entry.messaging || []) {
        const text = ev.message?.text;
        if (!text || ev.message.is_echo) continue;
        const sender = ev.sender.id;
        try {
          console.log('webhook: message from', sender, JSON.stringify(text).slice(0, 60));
          if (/מחק|DELETE/i.test(text)) {
            const un = await usernameOf(sender);
            const i = residents.findIndex((r) => r.handle === un);
            if (i >= 0) { residents.splice(i, 1); save(); await sendDM(sender, 'מחקתי אותך מהאי.'); }
            else { await sendDM(sender, 'לא מצאתי אותך על האי.'); }
            continue;
          }
          const m = text.toUpperCase().match(/WEIRD-\d{4}/);
          if (!m) { await sendDM(sender, 'שלח לי את הקוד שקיבלת באתר, למשל WEIRD-1234'); continue; }
          const p = pending.get(m[0]);
          if (!p || p.exp < Date.now()) { await sendDM(sender, 'הקוד לא תקף או שפג תוקפו. תבקש קוד חדש באתר.'); continue; }
          const uname = await usernameOf(sender);
          console.log('webhook: sender username =', uname, ', expected =', p.handle);
          if (uname !== p.handle) { await sendDM(sender, 'הקוד הזה שייך למשתמש אחר.'); continue; }
          console.log('webhook: verified', p.handle);
          p.verified = true;
          residents.push({ handle: p.handle, joined: Date.now() });
          save();
          await sendDM(sender, `קיבלתי, @${p.handle}! בונה לך בית על האי 🏝️`);
        } catch (e) {
          console.error('webhook error', e);
        }
      }
    }
  })();
});

app.listen(PORT, () => console.log(`Island bot on :${PORT}`));
