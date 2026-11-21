const fs = require("node:fs");
const path = require("node:path");

const serverPath = path.join(__dirname, "server.js");
const htmlPath = path.join(__dirname, "public/index.html");

let server = fs.readFileSync(serverPath, "utf8");
let html = fs.readFileSync(htmlPath, "utf8");

function replaceOnce(source, oldText, newText, label) {
  const first = source.indexOf(oldText);
  if (first < 0 || source.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error("Could not uniquely locate: " + label);
  }
  return source.slice(0, first) + newText + source.slice(first + oldText.length);
}

// Validate all expected sections before changing any live file.
const checks = [
  ["server", "ALTER TABLE users ADD COLUMN last_seen_at TEXT DEFAULT NULL"],
  ["server", "m.id AS last_message_id"],
  ["server", "const after = validId(url.searchParams.get('after')) || 0;"],
  ["server", "INSERT INTO messages(chat_id,user_id,body) VALUES(?,?,?)"],
  ["html", "unread: 0,"],
  ["html", 'list.querySelectorAll(".chat-row").forEach(row => {'],
  ["html", '$("chatAvatar").textContent = currentChat.avatar;'],
  ["html", "out: String(m.user_id) === String(currentUser.id)"],
  ["html", "box.scrollTop = box.scrollHeight;"]
];

for (const [file, needle] of checks) {
  const source = file === "server" ? server : html;
  if (!source.includes(needle)) throw new Error("Missing expected section: " + needle);
}

// Backend: read receipt column.
server = replaceOnce(
  server,
  "try {\n  db.exec('ALTER TABLE users ADD COLUMN last_seen_at TEXT DEFAULT NULL');\n} catch {}",
  "try {\n  db.exec('ALTER TABLE users ADD COLUMN last_seen_at TEXT DEFAULT NULL');\n} catch {}\ntry {\n  db.exec('ALTER TABLE messages ADD COLUMN read_at TEXT DEFAULT NULL');\n} catch {}",
  "read receipt migration"
);

// Backend: unread count in chat list.
server = replaceOnce(
  server,
  "m.id AS last_message_id",
  "m.id AS last_message_id,\n        (SELECT COUNT(*) FROM messages unread WHERE unread.chat_id=c.id AND unread.user_id<>? AND unread.read_at IS NULL) AS unread_count",
  "unread count query"
);

server = replaceOnce(
  server,
  ").all(user.id, user.id);",
  ").all(user.id, user.id, user.id);",
  "chat list query parameters"
);

// Backend: opening a conversation marks incoming messages read.
server = replaceOnce(
  server,
  "const after = validId(url.searchParams.get('after')) || 0;",
  "db.prepare('UPDATE messages SET read_at=CURRENT_TIMESTAMP WHERE chat_id=? AND user_id<>? AND read_at IS NULL').run(chatId, user.id);\n\n    const after = validId(url.searchParams.get('after')) || 0;",
  "mark incoming messages read"
);

// Include read_at in both message result queries.
const selectNeedle = "m.created_at,m.edited_at,";
if ((server.match(/m\.created_at,m\.edited_at,/g) || []).length !== 2) {
  throw new Error("Expected two message SELECT statements.");
}
server = server.replaceAll(selectNeedle, "m.created_at,m.edited_at,m.read_at,");

// Frontend: retain online status and map photo/unread fields.
html = replaceOnce(
  html,
  "      unread: 0,\n      online: false,",
  "      unread: Number(c.unread_count) || 0,\n      profile_picture: c.other_profile_picture || null,",
  "chat list data mapping"
);

// Frontend: show unread badge and emphasize unread conversations.
html = replaceOnce(
  html,
  '<div class="chat-time">${escapeHtml(c.time)}</div>',
  '<div class="chat-time">${escapeHtml(c.time)}</div>\n          ${c.unread ? \'<span class="unread-badge">\' + c.unread + \'</span>\' : \'\'}',
  "unread badge"
);

html = replaceOnce(
  html,
  '<div class="chat-name">${escapeHtml(c.name)}</div>',
  '<div class="chat-name" style="${c.unread ? \'font-weight:700\' : \'\'}">${escapeHtml(c.name)}</div>',
  "unread chat name"
);

html = replaceOnce(
  html,
  '<div class="chat-preview">${escapeHtml(c.preview)}</div>',
  '<div class="chat-preview" style="${c.unread ? \'font-weight:700\' : \'\'}">${escapeHtml(c.preview)}</div>',
  "unread chat preview"
);

// Show other users' profile photos in chat-list avatars.
html = replaceOnce(
  html,
  '  list.querySelectorAll(".chat-row").forEach(row => {\n    row.onclick = () => openChat(row.dataset.chat);',
  '  list.querySelectorAll(".chat-row").forEach(row => {\n    const chat = chats.find(c => String(c.id) === String(row.dataset.chat));\n    if (chat && chat.profile_picture) {\n      const avatar = row.querySelector(".avatar");\n      const img = document.createElement("img");\n      img.src = chat.profile_picture;\n      img.alt = "";\n      avatar.textContent = "";\n      avatar.appendChild(img);\n    }\n  });\n\n  list.querySelectorAll(".chat-row").forEach(row => {\n    row.onclick = () => openChat(row.dataset.chat);',
  "chat list profile photos"
);

// Show the other user's photo in the open-chat header.
html = replaceOnce(
  html,
  '$("chatAvatar").textContent = currentChat.avatar;',
  'const chatAvatar = $("chatAvatar");\n  chatAvatar.textContent = "";\n  if (currentChat.profile_picture) {\n    const img = document.createElement("img");\n    img.src = currentChat.profile_picture;\n    img.alt = "";\n    chatAvatar.appendChild(img);\n  } else {\n    chatAvatar.textContent = currentChat.avatar;\n  }',
  "chat header profile photo"
);

// Refresh unread counts after opening a conversation.
html = replaceOnce(
  html,
  "  await loadMessages(id);\n  renderChats();",
  "  await loadMessages(id);\n  await loadChats();\n  renderChats();",
  "refresh unread count after opening"
);

// Read receipt state from the backend.
html = replaceOnce(
  html,
  "      out: String(m.user_id) === String(currentUser.id)",
  "      out: String(m.user_id) === String(currentUser.id),\n      read: Boolean(m.read_at)",
  "message read state"
);

// Display one tick or double ticks.
html = replaceOnce(
  html,
  "    el.innerHTML = '<div>' + escapeHtml(msg.text) + '</div><div class=\"message-time\">' + escapeHtml(msg.time) + (msg.out ? ' ✓' : '') + '</div>';",
  "    el.innerHTML = '<div>' + escapeHtml(msg.text) + '</div><div class=\"message-time\">' + escapeHtml(msg.time) + (msg.out ? (msg.read ? ' <span class=\"read-tick\">✓✓</span>' : ' ✓') : '') + '</div>';",
  "message ticks"
);

// Add small styles without replacing existing CSS.
html = replaceOnce(
  html,
  "</style>",
  ".avatar img,#chatAvatar img{width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block}\n.unread-badge{display:inline-flex;align-items:center;justify-content:center;min-width:19px;height:19px;padding:0 6px;border-radius:12px;background:#229ED9;color:#fff;font-size:11px;font-weight:700;margin-left:6px}\n.read-tick{color:#42b7f5;font-weight:700;letter-spacing:-2px}\n</style>",
  "upgrade styles"
);

// Syntax-check both changed files before backing up or installing.
new Function(html.match(/<script[^>]*>([\s\S]*?)<\/script>/i)[1]);
new Function("require", "module", "exports", server.replace(/^#!.*\n/, ""));

// Back up, then install.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.copyFileSync(serverPath, serverPath + ".backup-" + stamp);
fs.copyFileSync(htmlPath, htmlPath + ".backup-" + stamp);

fs.writeFileSync(serverPath, server);
fs.writeFileSync(htmlPath, html);

console.log("STUMZY chat upgrades installed.");
console.log("Backups created with suffix: " + stamp);
console.log("Profile photos, unread badges, read receipts and online status updated.");
