const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const file = path.join(__dirname, "public", "index.html");
const html = fs.readFileSync(file, "utf8");
let out = html;

function requireText(text, label) {
  if (!out.includes(text)) throw new Error("Missing required section: " + label);
}

function replaceOnce(oldText, newText, label) {
  requireText(oldText, label);
  out = out.replace(oldText, newText);
}

function replaceFunction(name, nextName, replacement) {
  const start = out.indexOf("function " + name + "(");
  const end = out.indexOf("async function " + nextName + "(", start + 1);
  if (start < 0 || end < 0) {
    throw new Error("Could not safely locate function " + name);
  }
  out = out.slice(0, start) + replacement + "\n\n" + out.slice(end);
}

requireText("</style>", "CSS closing tag");
requireText('<div id="chatList"', "chat list");
requireText("function loadMessages(id)", "message loader");
requireText("function renderMessages()", "message renderer");
requireText("function sendMessage(text)", "message sender");
requireText('$("attachBtn").onclick', "attachment button");
requireText('$("messageInput").addEventListener("input"', "message input");
requireText("/* VOICE_NOTES_FEATURE: recorder */", "voice recorder boundary");
requireText("/* COMPOSER */", "composer boundary");

/* CSS */
const css = `
/* STUMZY MEDIA AND STORIES */
.stumzy-stories{display:flex;gap:13px;overflow-x:auto;padding:13px 15px;scrollbar-width:none}
.stumzy-story{flex:0 0 66px;text-align:center;font-size:11px;overflow:hidden}
.stumzy-story-ring{width:58px;height:58px;border-radius:50%;padding:3px;margin:auto auto 5px;background:linear-gradient(135deg,#229ed9,#a855f7,#ff9f43)}
.stumzy-story-ring img{width:100%;height:100%;border-radius:50%;object-fit:cover;border:2px solid white}
.stumzy-story-add{width:58px;height:58px;border-radius:50%;border:2px dashed #229ed9;display:grid;place-items:center;font-size:27px;margin:auto auto 5px}
.message-media{display:block;max-width:230px;max-height:280px;border-radius:12px;margin:5px 0;object-fit:contain}
.message-file{display:block;padding:10px;border-radius:10px;background:rgba(100,100,100,.12);overflow-wrap:anywhere}
.message-actions{display:flex;justify-content:flex-end;margin-top:4px}
.message-actions button{border:0;background:transparent;color:inherit;font-size:12px;opacity:.7;padding:3px 6px}
.stumzy-modal{position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:99999;display:flex;align-items:center;justify-content:center;padding:18px}
.stumzy-modal-inner{width:100%;max-width:480px;color:white;text-align:center}
.stumzy-modal-inner img,.stumzy-modal-inner video{max-width:100%;max-height:72vh;border-radius:12px}
.stumzy-modal-inner button{margin:8px;padding:10px 15px;border:0;border-radius:9px}
.stumzy-caption{overflow-wrap:anywhere;margin:12px}
`;

/* Stories bar */
const storyBar = `
<div id="stumzyStories" class="stumzy-stories">
  <div class="stumzy-story" id="addStory">
    <div class="stumzy-story-add">+</div>
    <div>Your story</div>
  </div>
</div>
`;

replaceOnce("</style>", css + "\n</style>", "CSS insertion");
replaceOnce('<div id="chatList"', storyBar + '\n<div id="chatList"', "stories bar insertion");

/* Preserve message IDs and sender IDs */
replaceOnce(
`localMessages[id] = (result.messages || []).map(m => ({
      text: m.body,`,
`localMessages[id] = (result.messages || []).map(m => ({
      id: m.id,
      user_id: m.user_id,
      text: m.body,`,
"message ID mapping"
);

/* Replace message renderer */
replaceFunction(
  "renderMessages",
  "sendMessage",
  String.raw`function renderMessages() {
  const box = $("messages");
  if (!currentChat) return;
  const msgs = localMessages[currentChat.id] || [];
  box.innerHTML = '<div class="date-chip">Today</div>';

  msgs.forEach(msg => {
    const el = document.createElement("div");
    el.className = "message " + (msg.out ? "out" : "in");

    if (msg.type === "deleted") {
      const deleted = document.createElement("div");
      deleted.textContent = "This message was deleted";
      deleted.style.fontStyle = "italic";
      deleted.style.opacity = ".7";
      el.appendChild(deleted);
    } else if (msg.type === "voice" && msg.media_url) {
      const label = document.createElement("div");
      label.className = "voice-label";
      label.textContent = "🎙 Voice message";
      const audio = document.createElement("audio");
      audio.className = "voice-player";
      audio.controls = true;
      audio.preload = "none";
      audio.src = msg.media_url;
      el.appendChild(label);
      el.appendChild(audio);
    } else if (msg.type === "image" && msg.media_url) {
      const img = document.createElement("img");
      img.className = "message-media";
      img.src = msg.media_url;
      img.alt = "Photo attachment";
      img.loading = "lazy";
      el.appendChild(img);
      if (msg.text) {
        const caption = document.createElement("div");
        caption.textContent = msg.text;
        el.appendChild(caption);
      }
    } else if (msg.type === "video" && msg.media_url) {
      const video = document.createElement("video");
      video.className = "message-media";
      video.controls = true;
      video.preload = "metadata";
      video.src = msg.media_url;
      el.appendChild(video);
      if (msg.text) {
        const caption = document.createElement("div");
        caption.textContent = msg.text;
        el.appendChild(caption);
      }
    } else if (msg.type === "document" && msg.media_url) {
      const link = document.createElement("a");
      link.className = "message-file";
      link.href = msg.media_url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "📄 " + (msg.text || "Open document");
      el.appendChild(link);
    } else {
      const body = document.createElement("div");
      body.textContent = msg.text || "";
      el.appendChild(body);
    }

    const actions = document.createElement("div");
    actions.className = "message-actions";
    const menu = document.createElement("button");
    menu.type = "button";
    menu.textContent = "⋮";
    menu.onclick = async () => {
      const choices = msg.out
        ? "1 = Delete for me\n2 = Delete for everyone\nCancel = Keep message"
        : "1 = Delete for me\nCancel = Keep message";
      const choice = prompt(choices);
      if (choice !== "1" && !(choice === "2" && msg.out)) return;
      try {
        await api("/api/messages/" + msg.id, {
          method: "DELETE",
          body: JSON.stringify({scope: choice === "2" ? "everyone" : "me"})
        });
        await loadMessages(currentChat.id);
        toast("Message deleted");
      } catch (error) {
        toast(error.message || "Could not delete message");
      }
    };
    actions.appendChild(menu);
    el.appendChild(actions);

    const time = document.createElement("div");
    time.className = "message-time";
    time.textContent = msg.time || "";
    if (msg.out && msg.type !== "deleted") {
      const tick = document.createElement("span");
      tick.className = "read-tick";
      tick.textContent = msg.read ? " ✓✓" : " ✓";
      time.appendChild(tick);
    }
    el.appendChild(time);
    box.appendChild(el);
  });
  box.scrollTop = box.scrollHeight;
}`
);

/* Upload attachments */
const additions = String.raw`
/* STUMZY ATTACHMENTS */
async function stumzyUpload(file, story) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    toast("File must be 8 MB or smaller");
    return;
  }
  if (!currentChat && !story) {
    toast("Open a chat first");
    return;
  }

  const allowed = story
    ? ["image/jpeg","image/png","image/webp","video/mp4","video/webm"]
    : ["image/jpeg","image/png","image/webp","image/gif","video/mp4","video/webm","application/pdf","text/plain","application/zip","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];

  if (!allowed.includes(file.type)) {
    toast("This file type is not supported");
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = String(reader.result).split(",")[1];
      if (!data) throw new Error("Could not read file");
      if (story) {
        const caption = prompt("Add a story caption (optional):") || "";
        await api("/api/stories", {
          method: "POST",
          body: JSON.stringify({mime:file.type,data,caption})
        });
        await stumzyLoadStories();
        toast("Story posted");
      } else {
        const caption = prompt("Add a caption (optional):") || "";
        await api("/api/chats/" + currentChat.id + "/attachments", {
          method: "POST",
          body: JSON.stringify({mime:file.type,data,caption})
        });
        await loadMessages(currentChat.id);
        await loadChats();
        toast("Attachment sent");
      }
    } catch (error) {
      toast(error.message || "Upload failed");
    }
  };
  reader.onerror = () => toast("Could not read file");
  reader.readAsDataURL(file);
}

function stumzyChooseFile(story) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = story
    ? "image/jpeg,image/png,image/webp,video/mp4,video/webm"
    : "image/*,video/mp4,video/webm,.pdf,.txt,.zip,.docx,.xlsx";
  input.onchange = () => {
    if (input.files && input.files[0]) stumzyUpload(input.files[0], story);
  };
  input.click();
}

/* STUMZY STORIES */
async function stumzyLoadStories() {
  const bar = $("stumzyStories");
  if (!bar) return;
  try {
    const result = await api("/api/stories");
    const stories = result.stories || [];
    bar.innerHTML = "";
    const add = document.createElement("div");
    add.className = "stumzy-story";
    add.innerHTML = '<div class="stumzy-story-add">+</div><div>Your story</div>';
    add.onclick = () => stumzyChooseFile(true);
    bar.appendChild(add);

    const seen = new Set();
    stories.forEach(story => {
      const key = String(story.id);
      if (seen.has(key)) return;
      seen.add(key);
      const item = document.createElement("div");
      item.className = "stumzy-story";
      const ring = document.createElement("div");
      ring.className = "stumzy-story-ring";
      const avatar = document.createElement("img");
      avatar.src = story.profile_picture || "/favicon.ico";
      avatar.alt = "";
      ring.appendChild(avatar);
      const name = document.createElement("div");
      name.textContent = story.display_name || story.username || "Story";
      item.appendChild(ring);
      item.appendChild(name);
      item.onclick = () => stumzyViewStory(story);
      bar.appendChild(item);
    });
  } catch (error) {
    console.warn("Stories could not load", error);
  }
}

function stumzyViewStory(story) {
  const modal = document.createElement("div");
  modal.className = "stumzy-modal";
  const inner = document.createElement("div");
  inner.className = "stumzy-modal-inner";
  const heading = document.createElement("div");
  heading.textContent = story.display_name || story.username || "Story";
  inner.appendChild(heading);

  let media;
  if (String(story.type).toLowerCase() === "video" ||
      String(story.media_mime).startsWith("video/")) {
    media = document.createElement("video");
    media.controls = true;
    media.autoplay = true;
    media.playsInline = true;
  } else {
    media = document.createElement("img");
    media.alt = "Story";
  }
  media.src = story.media_url;
  inner.appendChild(media);

  if (story.caption) {
    const caption = document.createElement("div");
    caption.className = "stumzy-caption";
    caption.textContent = story.caption;
    inner.appendChild(caption);
  }

  if (String(story.user_id) === String(currentUser.id)) {
    const remove = document.createElement("button");
    remove.textContent = "Delete story";
    remove.onclick = async () => {
      if (!confirm("Delete this story?")) return;
      try {
        await api("/api/stories/" + story.id, {method:"DELETE"});
        modal.remove();
        await stumzyLoadStories();
        toast("Story deleted");
      } catch (error) {
        toast(error.message || "Could not delete story");
      }
    };
    inner.appendChild(remove);
  }

  const close = document.createElement("button");
  close.textContent = "Close";
  close.onclick = () => modal.remove();
  inner.appendChild(close);
  modal.appendChild(inner);
  modal.onclick = event => {
    if (event.target === modal) modal.remove();
  };
  document.body.appendChild(modal);
}

/* STUMZY TYPING INDICATOR */
let stumzyTypingTimer = null;
let stumzyTypingPoll = null;

async function stumzySetTyping(value) {
  if (!currentChat) return;
  try {
    await api("/api/chats/" + currentChat.id + "/typing", {
      method: "POST",
      body: JSON.stringify({typing:value})
    });
  } catch (error) {}
}

async function stumzyPollTyping() {
  if (!currentChat) return;
  try {
    const result = await api("/api/chats/" + currentChat.id + "/typing");
    const typing = result.typing || [];
    if (typing.length) {
      const names = typing.map(x => x.display_name || x.username || "Someone");
      $("chatStatus").textContent = names.join(", ") + (names.length > 1 ? " are typing…" : " is typing…");
    } else {
      updateChatStatus();
    }
  } catch (error) {}
}

function stumzyStartTyping() {
  if (!currentChat) return;
  stumzySetTyping(true);
  clearTimeout(stumzyTypingTimer);
  stumzyTypingTimer = setTimeout(() => stumzySetTyping(false), 2500);
}

function stumzyStopTyping() {
  clearTimeout(stumzyTypingTimer);
  stumzySetTyping(false);
}

if (!stumzyTypingPoll) {
  stumzyTypingPoll = setInterval(stumzyPollTyping, 2000);
}
`;

const voiceMarker = "/* VOICE_NOTES_FEATURE: recorder */";
out = out.replace(voiceMarker, additions + "\n\n" + voiceMarker);

/* Wire up controls without changing voice recorder */
replaceOnce(
`$("messageInput").addEventListener("input", function() {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 120) + "px";
});`,
`$("messageInput").addEventListener("input", function() {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 120) + "px";
  stumzyStartTyping();
});`,
"typing input handler"
);

replaceOnce(
`$("attachBtn").onclick = () => toast("Attachments coming soon");`,
`$("attachBtn").onclick = () => stumzyChooseFile(false);`,
"attachment button wiring"
);

/* Stop typing when sending or leaving chat */
replaceOnce(
`sendMessage(text);
  input.value = "";`,
`stumzyStopTyping();
  sendMessage(text);
  input.value = "";`,
"stop typing on send"
);

replaceOnce(
`$("chatBack").onclick = () => {
  showScreen("home");
};`,
`$("chatBack").onclick = () => {
  stumzyStopTyping();
  showScreen("home");
};`,
"stop typing on back"
);

/* Load stories after session restoration */
replaceOnce(
`checkSession();`,
`checkSession();
setTimeout(stumzyLoadStories, 1800);`,
"initial stories load"
);

/* Validate before replacing the original */
const scriptMatches = [...out.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
if (!scriptMatches.length) throw new Error("No script block found");

const checkFile = path.join(__dirname, ".stumzy-frontend-check.js");
try {
  fs.writeFileSync(checkFile, scriptMatches.map(x => x[1]).join("\n"), "utf8");
  execFileSync(process.execPath, ["--check", checkFile], {stdio:"inherit"});
} finally {
  if (fs.existsSync(checkFile)) fs.unlinkSync(checkFile);
}

/* Backup and atomic replacement */
const backup = file + ".backup-" + new Date().toISOString().replace(/[:.]/g,"-");
fs.copyFileSync(file, backup);

const temp = file + ".installing";
fs.writeFileSync(temp, out, "utf8");
fs.renameSync(temp, file);

console.log("STUMZY frontend features installed successfully.");
console.log("Backup: " + backup);
console.log("Installed: stories, media attachments, typing indicators, message deletion.");
console.log("Voice-note recorder preserved. Voice calls remain unchanged.");
