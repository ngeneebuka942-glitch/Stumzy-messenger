
"use strict";

/* APP STATE */
let currentUser = null;
let currentChat = null;
let signupMode = false;
let activeFilter = "all";
let chats = [];
let localMessages = {};
let toastTimer = null;

const $ = id => document.getElementById(id);

const screens = {
  auth: $("authScreen"),
  home: $("homeScreen"),
  chat: $("chatScreen"),
  settings: $("settingsScreen")
};

/* HAPTICS */
function buzz(ms = 15) {
  if (localStorage.getItem("stumzy_haptics") === "off") return;
  try {
    if (navigator.vibrate) navigator.vibrate(ms);
  } catch(e) {}
}

/* TOAST */
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

/* SCREEN NAVIGATION */
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove("active"));
  screens[name].classList.add("active");
  buzz(8);
}

/* API */
async function api(path, options = {}) {
  const token = localStorage.getItem("stumzy_token");

  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (token) headers.Authorization = "Bearer " + token;

  const response = await fetch(path, {
    ...options,
    headers
  });

  let data = {};
  try {
    data = await response.json();
  } catch(e) {}

  if (!response.ok) {
    throw new Error(data.error || data.message || "Request failed");
  }

  return data;
}

/* AUTH */
function setSignup(value) {
  signupMode = value;

  $("nameField").classList.toggle("hidden", !value);
  $("authTitle").textContent = value ? "Create your account" : "Welcome to STUMZY";
  $("authSubtitle").textContent = value ? "Join the conversation." : "Connect. Chat. Be yourself.";
  $("authButton").textContent = value ? "Create Account" : "Log In";
  $("switchText").textContent = value ? "Already have an account?" : "Don't have an account?";
  $("switchAuth").textContent = value ? "Log In" : "Sign Up";
  $("passwordInput").autocomplete = value ? "new-password" : "current-password";
  $("authError").textContent = "";
}

$("switchAuth").onclick = () => setSignup(!signupMode);

$("authForm").addEventListener("submit", async e => {
  e.preventDefault();

  const username = $("usernameInput").value.trim().toLowerCase();
  const password = $("passwordInput").value;
  const name = $("nameInput").value.trim();

  $("authError").textContent = "";
  $("authButton").disabled = true;
  $("authButton").textContent = "Please wait...";

  try {
    const result = await api(signupMode ? "/api/register" : "/api/login", {
      method: "POST",
      body: JSON.stringify({
        username,
        displayName: name || username,
        password
      })
    });

    if (result.token) {
      localStorage.setItem("stumzy_token", result.token);
    }

    currentUser = result.user || result;
    enterApp();
  } catch(err) {
    $("authError").textContent = err.message;
  } finally {
    $("authButton").disabled = false;
    $("authButton").textContent = signupMode ? "Create Account" : "Log In";
  }
});

/* SESSION */
async function checkSession() {
  const token = localStorage.getItem("stumzy_token");

  if (!token) {
    showScreen("auth");
    return;
  }

  try {
    const result = await api("/api/me");
    currentUser = result.user || result;
    enterApp();
  } catch(e) {
    localStorage.removeItem("stumzy_token");
    showScreen("auth");
  }
}

function enterApp() {
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
}

function updateProfile() {
  const name = currentUser?.name || currentUser?.username || "STUMZY User";
  const email = currentUser?.email || "";

  $("profileName").textContent = currentUser?.display_name || name;
  $("profileEmail").textContent = email;
  $("profileAvatar").textContent = name.charAt(0).toUpperCase();
}

/* CHAT LIST */
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

  list.innerHTML = filtered.map(c => `
    <div class="chat-row" data-chat="${escapeHtml(c.id)}">
      <div class="avatar" style="background:${c.color}">${escapeHtml(c.avatar)}</div>
      <div class="chat-info">
        <div class="chat-name-line">
          <div class="chat-name">${escapeHtml(c.name)}</div>
          <div class="chat-time">${escapeHtml(c.time)}</div>
        </div>
        <div class="chat-preview">${escapeHtml(c.preview)}</div>
      </div>
    </div>`).join("");

  list.querySelectorAll(".chat-row").forEach(row => {
    row.onclick = () => openChat(row.dataset.chat);
  });
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* NEW CHAT */
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
}

/* OPEN CHAT */
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
}

/* MESSAGES */
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
}

/* COMPOSER */
$("messageForm").addEventListener("submit", e => {
  e.preventDefault();

  const input = $("messageInput");
  const text = input.value;

  if (!text.trim()) return;

  sendMessage(text);
  input.value = "";
  input.style.height = "auto";
});

$("messageInput").addEventListener("input", function() {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 120) + "px";
});

$("messageInput").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("messageForm").requestSubmit();
  }
});

/* NAVIGATION */
$("chatBack").onclick = () => {
  showScreen("home");
};

$("settingsBack").onclick = () => {
  showScreen("home");
};

$("newChatFab").onclick = newChat;
$("settingsQuick").onclick = () => showScreen("settings");

document.querySelectorAll(".tab").forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    activeFilter = tab.dataset.filter;
    renderChats();
    buzz(8);
  };
});

document.querySelectorAll(".nav-item").forEach(item => {
  item.onclick = () => {
    document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
    item.classList.add("active");

    const nav = item.dataset.nav;

    if (nav === "settings") {
      showScreen("settings");
    } else if (nav === "chats") {
      showScreen("home");
    } else {
      toast(nav === "contacts" ? "Contacts are coming soon" : "Calls are coming soon");
    }
  };
});

/* SEARCH */
$("searchToggle").onclick = () => {
  $("searchWrap").classList.toggle("show");

  if ($("searchWrap").classList.contains("show")) {
    $("searchInput").focus();
  } else {
    $("searchInput").value = "";
    renderChats();
  }
};

$("searchInput").addEventListener("input", renderChats);

/* THEMES */
function setDark(enabled) {
  document.body.classList.toggle("dark", enabled);
  localStorage.setItem("stumzy_dark", enabled ? "on" : "off");
  $("darkToggle").classList.toggle("on", enabled);
  $("themeQuick").textContent = enabled ? "☀" : "☾";
}

function toggleDark() {
  setDark(!document.body.classList.contains("dark"));
  buzz(10);
}

$("darkSetting").onclick = toggleDark;
$("themeQuick").onclick = toggleDark;

const savedDark = localStorage.getItem("stumzy_dark") === "on";
setDark(savedDark);

/* ACCENT COLORS */
document.querySelectorAll(".color").forEach(button => {
  button.onclick = () => {
    const color = button.dataset.color;
    document.documentElement.style.setProperty("--blue", color);
    localStorage.setItem("stumzy_color", color);

    document.querySelectorAll(".color").forEach(c => c.classList.remove("selected"));
    button.classList.add("selected");

    buzz(10);
  };
});

const savedColor = localStorage.getItem("stumzy_color");
if (savedColor) {
  document.documentElement.style.setProperty("--blue", savedColor);
  document.querySelectorAll(".color").forEach(c => {
    c.classList.toggle("selected", c.dataset.color === savedColor);
  });
}

/* HAPTICS */
$("hapticToggle").onclick = () => {
  const enabled = $("hapticToggle").classList.toggle("on");
  localStorage.setItem("stumzy_haptics", enabled ? "on" : "off");
  if (enabled && navigator.vibrate) navigator.vibrate(20);
};

if (localStorage.getItem("stumzy_haptics") === "off") {
  $("hapticToggle").classList.remove("on");
}

/* PLACEHOLDERS */
$("attachBtn").onclick = () => toast("Attachments coming soon");
$("callBtn").onclick = () => toast("Calls are coming soon");
$("chatMenuBtn").onclick = () => toast("Chat options coming soon");

/* LOGOUT */
$("logoutBtn").onclick = async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } catch(e) {}

  localStorage.removeItem("stumzy_token");
  currentUser = null;
  chats = [];
  localMessages = {};
  $("authForm").reset();
  setSignup(false);
  showScreen("auth");
  toast("Logged out");
};

/* START */
checkSession();
