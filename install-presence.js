const fs = require('node:fs');
const vm = require('node:vm');

const serverPath = 'server.js';
const htmlPath = 'public/index.html';

let server = fs.readFileSync(serverPath, 'utf8');
let html = fs.readFileSync(htmlPath, 'utf8');

function replaceOnce(source, oldText, newText, label) {
  const first = source.indexOf(oldText);
  if (first < 0 || source.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error('Cannot safely locate: ' + label);
  }
  return source.slice(0, first) + newText + source.slice(first + oldText.length);
}

if (server.includes('PRESENCE FEATURE')) {
  throw new Error('Presence patch already installed.');
}

server = replaceOnce(server,
  "try {\n  db.exec('ALTER TABLE users ADD COLUMN profile_picture TEXT DEFAULT NULL');\n} catch {}",
  "try {\n  db.exec('ALTER TABLE users ADD COLUMN profile_picture TEXT DEFAULT NULL');\n} catch {}\n\n// PRESENCE FEATURE: safe migration\ntry {\n  db.exec('ALTER TABLE users ADD COLUMN last_seen_at TEXT DEFAULT NULL');\n} catch {}",
  'database migration'
);

server = replaceOnce(server,
  '  // CURRENT USER\n',
  `  // PRESENCE FEATURE
  if (method === 'POST' && pathname === '/api/presence') {
    const user = requireUser(req, res);
    if (!user) return;
    db.prepare("UPDATE users SET last_seen_at=datetime('now') WHERE id=?").run(user.id);
    return send(res, 200, { success: true });
  }

  // CURRENT USER
`,
  'presence route'
);

server = replaceOnce(server,
  '        u.profile_picture AS other_profile_picture,',
  `        u.profile_picture AS other_profile_picture,
        u.last_seen_at AS last_seen_at,
        CASE WHEN u.last_seen_at >= datetime('now','-45 seconds')
             THEN 1 ELSE 0 END AS online,`,
  'chat presence query'
);

html = replaceOnce(html,
  '  loadChats();\n\n  if (window.stumzyPoller)',
  `  loadChats();
  api("/api/presence", {method:"POST"}).catch(() => {});
  if (window.stumzyPresenceTimer) clearInterval(window.stumzyPresenceTimer);
  window.stumzyPresenceTimer = setInterval(() => {
    if (document.visibilityState === "visible") {
      api("/api/presence", {method:"POST"}).catch(() => {});
    }
  }, 15000);

  if (window.stumzyPoller)`,
  'presence heartbeat'
);

html = replaceOnce(html,
  '      username: c.other_username || "",',
  `      username: c.other_username || "",
      online: Boolean(c.online),
      last_seen_at: c.last_seen_at || null,`,
  'chat presence data'
);

html = replaceOnce(html,
  '    renderChats();\n  } catch(e) {\n    console.error(e);\n  }\n}\n\nfunction renderChats()',
  `    renderChats();
    if (currentChat) {
      const fresh = chats.find(c => String(c.id) === String(currentChat.id));
      if (fresh) {
        currentChat = fresh;
        updateChatStatus();
      }
    }
  } catch(e) {
    console.error(e);
  }
}

function renderChats()`,
  'refresh current chat status'
);

html = replaceOnce(html,
  '          <div class="chat-name">\${escapeHtml(c.name)}</div>',
  `          <div class="chat-name">\${escapeHtml(c.name)}</div>
          \${c.online ? '<span style="color:#2ecc71;font-size:11px">online</span>' : ''}`,
  'chat list online indicator'
);

html = replaceOnce(html,
  '/* OPEN CHAT */\nasync function openChat(id) {',
  `function updateChatStatus() {
  if (!currentChat) return;
  if (currentChat.online) {
    $("chatStatus").textContent = "Online";
    return;
  }
  if (!currentChat.last_seen_at) {
    $("chatStatus").textContent = "Last seen recently";
    return;
  }
  const date = new Date(currentChat.last_seen_at.replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) {
    $("chatStatus").textContent = "Last seen recently";
    return;
  }
  $("chatStatus").textContent = "Last seen " +
    date.toLocaleString([], {month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"});
}

/* OPEN CHAT */
async function openChat(id) {`,
  'chat status helper'
);

html = replaceOnce(html,
  '  $("chatStatus").textContent = currentChat.username ? "@" + currentChat.username : "STUMZY";',
  '  updateChatStatus();',
  'chat header status'
);

// Validate everything before changing the live files.
new vm.Script(server, {filename: serverPath});

const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
if (!scripts.length) throw new Error('No frontend scripts found.');
for (const match of scripts) {
  if (match[1].trim()) new vm.Script(match[1], {filename: htmlPath});
}

// Back up both originals, then write validated replacements.
const stamp = Date.now();
fs.mkdirSync('backups', {recursive:true});
fs.copyFileSync(serverPath, `backups/server-before-presence-${stamp}.js`);
fs.copyFileSync(htmlPath, `backups/index-before-presence-${stamp}.html`);

fs.writeFileSync(serverPath + '.tmp', server);
fs.writeFileSync(htmlPath + '.tmp', html);
fs.renameSync(serverPath + '.tmp', serverPath);
fs.renameSync(htmlPath + '.tmp', htmlPath);

console.log('SUCCESS: Online status and last seen installed.');
console.log('Backups saved in backups/.');
console.log('Server and frontend JavaScript validation passed.');
