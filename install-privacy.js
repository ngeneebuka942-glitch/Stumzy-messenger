const fs = require('fs');
const vm = require('vm');
const path = require('path');

const sp = path.join(__dirname, 'server.js');
const hp = path.join(__dirname, 'public/index.html');

let s = fs.readFileSync(sp, 'utf8');
let h = fs.readFileSync(hp, 'utf8');

function insertBefore(source, marker, addition, label) {
  const i = source.indexOf(marker);
  if (i < 0 || source.indexOf(marker, i + marker.length) !== -1)
    throw Error('Cannot safely locate ' + label);
  return source.slice(0, i) + addition + source.slice(i);
}
function replaceRange(source, start, end, replacement, label) {
  const a = source.indexOf(start);
  if (a < 0) throw Error('Cannot locate start of ' + label);
  const b = source.indexOf(end, a + start.length);
  if (b < 0) throw Error('Cannot locate end of ' + label);
  return source.slice(0, a) + replacement + source.slice(b + end.length);
}

if (s.includes('STUMZY_PRIVACY_API') || h.includes('STUMZY_PRIVACY_PANEL'))
  throw Error('Privacy feature already appears installed. No files changed.');

/* Database migrations */
const migration = "db.exec('ALTER TABLE messages ADD COLUMN read_at TEXT DEFAULT NULL');";
const mi = s.indexOf(migration);
if (mi < 0) throw Error('Cannot locate messages migration.');
const mend = s.indexOf('} catch {}', mi);
if (mend < 0) throw Error('Cannot locate migration ending.');

s = s.slice(0, mend + 10) +
  "\ntry { db.exec(\"ALTER TABLE users ADD COLUMN last_seen_visibility TEXT NOT NULL DEFAULT 'everyone'\"); } catch {}\n" +
  "try { db.exec(\"ALTER TABLE users ADD COLUMN profile_visibility TEXT NOT NULL DEFAULT 'everyone'\"); } catch {}\n" +
  "try { db.exec('ALTER TABLE users ADD COLUMN read_receipts INTEGER NOT NULL DEFAULT 1'); } catch {}\n" +
  s.slice(mend + 10);

/* Privacy API */
const routes = `
  // STUMZY_PRIVACY_API
  if (pathname === '/api/privacy') {
    const user = requireUser(req, res);
    if (!user) return;

    if (method === 'GET') {
      const settings = db.prepare(
        'SELECT last_seen_visibility,profile_visibility,read_receipts FROM users WHERE id=?'
      ).get(user.id);
      return send(res, 200, { settings });
    }

    if (method === 'PATCH') {
      const b = await readBody(req);
      const choices = ['everyone', 'contacts', 'nobody'];
      if (!choices.includes(b.last_seen_visibility) ||
          !choices.includes(b.profile_visibility) ||
          ![0, 1, true, false].includes(b.read_receipts)) {
        return send(res, 400, { error: 'Invalid privacy settings.' });
      }

      db.prepare(
        'UPDATE users SET last_seen_visibility=?,profile_visibility=?,read_receipts=? WHERE id=?'
      ).run(
        b.last_seen_visibility,
        b.profile_visibility,
        b.read_receipts ? 1 : 0,
        user.id
      );

      const settings = db.prepare(
        'SELECT last_seen_visibility,profile_visibility,read_receipts FROM users WHERE id=?'
      ).get(user.id);
      return send(res, 200, { settings });
    }
  }

`;
s = insertBefore(s, '  // LIST CHATS', routes, 'chat route insertion');

/* Apply visibility to chat list */
s = replaceRange(
  s,
  '        u.profile_picture AS other_profile_picture,',
  '        u.last_seen_at AS last_seen_at,',
  "        CASE WHEN u.profile_visibility='nobody' THEN NULL ELSE u.profile_picture END AS other_profile_picture,\n        CASE WHEN u.last_seen_visibility='nobody' THEN NULL ELSE u.last_seen_at END AS last_seen_at,",
  'profile and last-seen visibility'
);

s = replaceRange(
  s,
  "        CASE WHEN u.last_seen_at >= datetime('now','-45 seconds')",
  '        m.body AS last_message,',
  "        CASE WHEN u.last_seen_visibility='nobody' THEN 0\n             WHEN u.last_seen_at >= datetime('now','-45 seconds') THEN 1 ELSE 0 END AS online,\n",
  'online visibility'
);

/* Respect read receipt preference */
const readStart = "db.prepare('UPDATE messages SET read_at=CURRENT_TIMESTAMP";
const ri = s.indexOf(readStart);
if (ri < 0) throw Error('Cannot locate read receipt update.');
const rend = s.indexOf(';', ri);
if (rend < 0) throw Error('Cannot locate end of read receipt update.');
s = s.slice(0, ri) +
  "const privacy = db.prepare('SELECT read_receipts FROM users WHERE id=?').get(user.id);\n" +
  "    if (privacy && privacy.read_receipts) {\n      " +
  s.slice(ri, rend + 1) +
  "\n    }" + s.slice(rend + 1);

/* Make existing Privacy row open the new panel */
const privacyText = '<div>Privacy</div>';
const pi = h.indexOf(privacyText);
if (pi < 0) throw Error('Cannot locate Privacy setting in HTML.');
const rowStart = h.lastIndexOf('<div class="setting-row">', pi);
if (rowStart < 0) throw Error('Cannot locate Privacy setting row.');
h = h.slice(0, rowStart) +
  h.slice(rowStart).replace(
    '<div class="setting-row">',
    '<div class="setting-row" id="privacySetting" role="button" tabindex="0" style="cursor:pointer">',
  );
h = h.replace(
  '<div>Privacy</div>',
  '<div>Privacy &amp; Security</div>'
).replace(
  'Privacy features coming soon',
  'Last seen, profile photo and read receipts'
);

const panel = `
<!-- STUMZY_PRIVACY_PANEL -->
<div id="privacyPanel" style="display:none;position:fixed;inset:0;z-index:1000;background:var(--bg,#101820);color:var(--text,#fff);overflow-y:auto;padding:18px;box-sizing:border-box">
  <div style="max-width:560px;margin:auto">
    <header style="display:flex;align-items:center;gap:16px;padding:12px 0 22px">
      <button id="privacyBack" class="back-btn" type="button">‹</button>
      <h2>Privacy &amp; Security</h2>
    </header>
    <p style="opacity:.7;font-size:13px">Choose who can see your information.</p>

    <div class="section-label">LAST SEEN &amp; ONLINE</div>
    <div class="setting-row" style="display:block;padding:16px">
      <div style="margin-bottom:10px">Who can see when you're online?</div>
      <select id="privacyLastSeen" style="width:100%;padding:12px;border-radius:10px">
        <option value="everyone">Everyone</option>
        <option value="contacts">My contacts</option>
        <option value="nobody">Nobody</option>
      </select>
    </div>

    <div class="section-label">PROFILE PHOTO</div>
    <div class="setting-row" style="display:block;padding:16px">
      <div style="margin-bottom:10px">Who can see your profile photo?</div>
      <select id="privacyProfile" style="width:100%;padding:12px;border-radius:10px">
        <option value="everyone">Everyone</option>
        <option value="contacts">My contacts</option>
        <option value="nobody">Nobody</option>
      </select>
    </div>

    <div class="section-label">MESSAGING</div>
    <div class="setting-row" style="padding:16px">
      <div class="setting-text">
        <div>Read receipts</div>
        <div class="setting-desc">Let people know when you read messages</div>
      </div>
      <button id="privacyReceipts" class="toggle on" type="button"> </button>
    </div>
    <button id="privacySave" class="logout" type="button" style="margin-top:24px">Save changes</button>
  </div>
</div>
`;
h = insertBefore(h, '<div id="toast"', panel, 'toast element');

/* Frontend logic */
const frontend = `
/* STUMZY_PRIVACY_PANEL */
(function () {
  const panel = document.getElementById('privacyPanel');
  const entry = document.getElementById('privacySetting');
  const back = document.getElementById('privacyBack');
  const save = document.getElementById('privacySave');
  const toggle = document.getElementById('privacyReceipts');
  if (!panel || !entry || !back || !save || !toggle) return;

  let receipts = true;

  async function openPrivacy() {
    panel.style.display = 'block';
    try {
      const result = await api('/api/privacy');
      const settings = result.settings || {};
      document.getElementById('privacyLastSeen').value =
        settings.last_seen_visibility || 'everyone';
      document.getElementById('privacyProfile').value =
        settings.profile_visibility || 'everyone';
      receipts = Number(settings.read_receipts) !== 0;
      toggle.classList.toggle('on', receipts);
    } catch (e) {
      toast(e.message || 'Could not load privacy settings');
    }
  }

  entry.addEventListener('click', openPrivacy);
  entry.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPrivacy();
    }
  });
  back.addEventListener('click', () => panel.style.display = 'none');

  toggle.addEventListener('click', () => {
    receipts = !receipts;
    toggle.classList.toggle('on', receipts);
    if (typeof buzz === 'function') buzz(12);
  });

  save.addEventListener('click', async () => {
    save.disabled = true;
    save.textContent = 'Saving...';
    try {
      await api('/api/privacy', {
        method: 'PATCH',
        body: JSON.stringify({
          last_seen_visibility: document.getElementById('privacyLastSeen').value,
          profile_visibility: document.getElementById('privacyProfile').value,
          read_receipts: receipts ? 1 : 0
        })
      });
      toast('Privacy settings saved');
      panel.style.display = 'none';
      if (typeof loadChats === 'function') await loadChats();
    } catch (e) {
      toast(e.message || 'Could not save privacy settings');
    } finally {
      save.disabled = false;
      save.textContent = 'Save changes';
    }
  });
})();
`;
const close = h.lastIndexOf('</script>');
if (close < 0) throw Error('Cannot locate closing script tag.');
h = h.slice(0, close) + frontend + '\n' + h.slice(close);

/* Validate everything before touching live files */
new vm.Script(s, { filename: 'server.js' });
const chunks = h.split('<script').slice(1);
if (!chunks.length) throw Error('No frontend script found.');
for (let i = 0; i < chunks.length; i++) {
  const a = chunks[i].indexOf('>');
  const b = chunks[i].indexOf('</script>');
  if (a >= 0 && b > a) {
    const code = chunks[i].slice(a + 1, b).trim();
    if (code) new vm.Script(code, { filename: 'index.html script ' + (i + 1) });
  }
}

/* Backups and atomic replacement */
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.copyFileSync(sp, sp + '.backup-' + stamp);
fs.copyFileSync(hp, hp + '.backup-' + stamp);

const st = sp + '.tmp';
const ht = hp + '.tmp';
fs.writeFileSync(st, s);
fs.writeFileSync(ht, h);
fs.renameSync(st, sp);
fs.renameSync(ht, hp);

console.log('PRIVACY INSTALLATION SUCCESSFUL');
console.log('Both files validated and backups created.');
