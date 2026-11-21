const fs = require("fs");
const cp = require("child_process");

const file = "public/index.html";
let html = fs.readFileSync(file, "utf8");

function section(start, end, replacement) {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a + start.length);

  if (a === -1 || b === -1) throw Error("Missing section: " + start);

  html = html.substring(0, a) + replacement + "\n\n" + html.substring(b);
}

section("/* CHAT LIST */", "function escapeHtml(text)", `/* CHAT LIST */
async function loadChats() {
  try {
    const result = await api("/api/chats");
    chats = (result.chats || []).map(c => ({
      id: c.id,
      name: c.other_display_name || c.other_username || "User",
      username: c.other_username || "",
      avatar: (c.other_display_name || c.other_username || "U").charAt(0).toUpperCase(),
      color: "#229ED9",
      preview: c.last_message || "Start a conversation",
      time: c.last_message_at ? new Date(c.last_message_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) : "",
      unread: 0,
      online: false,
      type: "personal"
    }));
    renderChats();
  } catch(e) {
    console.error(e);
  }
}

function renderChats() {
  const list = $("chatList");
  const query = $("searchInput").value.trim().toLowerCase();

  const filtered = chats.filter(c =>
    (!query || c.name.toLowerCase().includes(query) || c.username.toLowerCase().includes(query)) &&
    (activeFilter === "all" || activeFilter === "personal")
  );

  if (!filtered.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">💬</div><h3>No conversations yet</h3><p>Tap the pencil button to start a chat.</p></div>';
    return;
  }

  list.innerHTML = filtered.map(c => \`
    <div class="chat-row" data-chat="\${escapeHtml(c.id)}">
      <div class="avatar" style="background:\${c.color}">\${escapeHtml(c.avatar)}</div>
      <div class="chat-info">
        <div class="chat-name-line">
          <div class="chat-name">\${escapeHtml(c.name)}</div>
          <div class="chat-time">\${escapeHtml(c.time)}</div>
        </div>
        <div class="chat-preview">\${escapeHtml(c.preview)}</div>
      </div>
    </div>\`).join("");

  list.querySelectorAll(".chat-row").forEach(row => {
    row.onclick = () => openChat(row.dataset.chat);
  });
}`);

section("/* DEMO CHAT */", "/* OPEN CHAT */", `/* NEW CHAT */
async function newChat() {
  const username = prompt("Enter their username:");
  if (!username || !username.trim()) return;

  try {
    const result = await api("/api/users/search?q=" + encodeURIComponent(username.trim()));
    const users = result.users || [];

    if (!users.length) {
      toast("User not found");
      return;
    }

    const target = users.find(u => u.username.toLowerCase() === username.trim().replace(/^@/, "").toLowerCase()) || users[0];

    if (String(target.id) === String(currentUser.id)) {
      toast("You cannot chat with yourself");
      return;
    }

    const created = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({userId: target.id})
    });

    await loadChats();
    await openChat(created.chatId);
  } catch(e) {
    toast(e.message);
  }
}`);

section("/* OPEN CHAT */", "/* MESSAGES */", `/* OPEN CHAT */
async function openChat(id) {
  currentChat = chats.find(c => String(c.id) === String(id));
  if (!currentChat) return;

  $("chatName").textContent = currentChat.name;
  $("chatAvatar").textContent = currentChat.avatar;
  $("chatStatus").textContent = currentChat.username ? "@" + currentChat.username : "STUMZY";
  $("chatAvatar").style.background = currentChat.color || "#229ED9";

  showScreen("chat");
  await loadMessages(id);
  renderChats();
  setTimeout(() => $("messageInput").focus(), 200);
}`);

section("/* MESSAGES */", "/* COMPOSER */", `/* MESSAGES */
async function loadMessages(id) {
  try {
    const result = await api("/api/chats/" + id + "/messages");
    localMessages[id] = (result.messages || []).map(m => ({
      text: m.body,
      time: new Date(m.created_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}),
      out: String(m.user_id) === String(currentUser.id)
    }));
    if (currentChat && String(currentChat.id) === String(id)) renderMessages();
  } catch(e) {
    toast("Could not load messages");
  }
}

function renderMessages() {
  const box = $("messages");
  if (!currentChat) return;
  const msgs = localMessages[currentChat.id] || [];

  box.innerHTML = '<div class="date-chip">Today</div>';

  msgs.forEach(msg => {
    const el = document.createElement("div");
    el.className = "message " + (msg.out ? "out" : "in");
    el.innerHTML = '<div>' + escapeHtml(msg.text) + '</div><div class="message-time">' + escapeHtml(msg.time) + (msg.out ? ' ✓' : '') + '</div>';
    box.appendChild(el);
  });

  box.scrollTop = box.scrollHeight;
}

async function sendMessage(text) {
  if (!text.trim() || !currentChat) return;

  try {
    await api("/api/chats/" + currentChat.id + "/messages", {
      method: "POST",
      body: JSON.stringify({body: text.trim()})
    });
    await loadMessages(currentChat.id);
    await loadChats();
    buzz(12);
  } catch(e) {
    toast(e.message || "Failed to send");
  }
}`);

section("function enterApp() {", "function updateProfile() {", `function enterApp() {
  showScreen("home");
  updateProfile();
  loadChats();

  if (window.stumzyPoller) clearInterval(window.stumzyPoller);
  window.stumzyPoller = setInterval(() => {
    loadChats();
    if (currentChat && $("chat").classList.contains("active")) {
      loadMessages(currentChat.id);
    }
  }, 3000);
}`);

const start = html.indexOf("<script");
const open = html.indexOf(">", start);
const close = html.indexOf("</script>", open);

if (start < 0 || open < 0 || close < 0) throw Error("Script tag missing");

fs.writeFileSync("connect-check.js", html.substring(open + 1, close));

const check = cp.spawnSync("node", ["--check", "connect-check.js"], {encoding:"utf8"});
if (check.status !== 0) {
  console.log(check.stderr);
  throw Error("Syntax check failed. HTML was not changed.");
}

fs.copyFileSync(file, "backups/index-before-connect.html");
fs.writeFileSync(file, html);

console.log("CONNECTED: frontend patched and syntax checked.");
