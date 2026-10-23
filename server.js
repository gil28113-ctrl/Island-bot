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
