const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const serverPath = path.join(__dirname, 'server.js');
const htmlPath = path.join(__dirname, 'public/index.html');

let server = fs.readFileSync(serverPath, 'utf8');
let html = fs.readFileSync(htmlPath, 'utf8');

function need(condition, message) {
  if (!condition) throw new Error(message);
}

function replaceOnce(source, pattern, replacement, label) {
  const matches = source.match(pattern);
  need(matches && matches.length === 1,
    'Could not safely locate ' + label + '. No files were changed.');
  return source.replace(pattern, replacement);
}

/* BACKEND: database migration */
need(server.includes("const uploadsDir = path.join(publicDir, 'uploads');"),
  'Uploads folder anchor not found.');

need(!server.includes('VOICE_NOTES_FEATURE'),
  'Voice notes already appear to be installed.');

server = server.replace(
  "const uploadsDir = path.join(publicDir, 'uploads');",
  `/* VOICE_NOTES_FEATURE: database migration */
for (const sql of [
  "ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'",
  "ALTER TABLE messages ADD COLUMN media_url TEXT",
  "ALTER TABLE messages ADD COLUMN media_mime TEXT",
  "ALTER TABLE messages ADD COLUMN duration REAL"
]) {
  try { db.exec(sql); } catch (e) {
    if (!String(e.message).includes('duplicate column')) throw e;
  }
}

const uploadsDir = path.join(publicDir, 'uploads');`
);

/* Include voice fields in message responses */
server = server.replaceAll(
  'm.edited_at,m.read_at,',
  'm.edited_at,m.read_at,m.type,m.media_url,m.media_mime,m.duration,'
);

/* BACKEND: separate voice upload endpoint */
const routeAnchor =
  "  const messagesMatch = pathname.match(/^\\/api\\/chats\\/(\\d+)\\/messages$/);";

need(server.includes(routeAnchor),
  'Message route anchor not found.');

const voiceRoute = `
  /* VOICE_NOTES_FEATURE: upload voice message */
  const voiceMatch = pathname.match(/^\\/api\\/chats\\/(\\d+)\\/voice$/);

  if (method === 'POST' && voiceMatch) {
    const user = requireUser(req, res);
    if (!user) return;

    const chatId = validId(voiceMatch[1]);
    if (!chatId || !isMember(chatId, user.id))
      return send(res, 403, { error: 'Conversation unavailable.' });

    const b = await readBody(req, 3 * 1024 * 1024);
    const mime = String(b.mime || '').split(';')[0].toLowerCase();
    const allowed = {
      'audio/webm': 'webm',
      'audio/ogg': 'ogg',
      'audio/mp4': 'm4a',
      'audio/aac': 'aac',
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav'
    };

    if (!allowed[mime])
      return send(res, 400, { error: 'Unsupported audio format.' });

    if (typeof b.audio !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(b.audio))
      return send(res, 400, { error: 'Invalid audio data.' });

    const audio = Buffer.from(b.audio, 'base64');
    if (!audio.length || audio.length > 2 * 1024 * 1024)
      return send(res, 400, { error: 'Voice note must be under 2 MB.' });

    const filename = 'voice-' + crypto.randomBytes(16).toString('hex') +
      '.' + allowed[mime];
    const filepath = path.join(uploadsDir, filename);

    fs.writeFileSync(filepath, audio, { flag: 'wx' });

    const duration = Math.max(0, Math.min(120, Number(b.duration) || 0));
    const mediaUrl = '/uploads/' + filename;

    try {
      const result = db.prepare(
        "INSERT INTO messages(chat_id,user_id,body,type,media_url,media_mime,duration) VALUES(?,?,?,'voice',?,?,?)"
      ).run(chatId, user.id, 'Voice message', mediaUrl, mime, duration);

      const message = db.prepare(\`
        SELECT m.id,m.chat_id,m.user_id,m.body,m.created_at,
               m.edited_at,m.read_at,m.type,m.media_url,m.media_mime,m.duration,
               u.username,u.display_name,u.profile_picture
        FROM messages m JOIN users u ON u.id=m.user_id
        WHERE m.id=?
      \`).get(Number(result.lastInsertRowid));

      return send(res, 201, { message });
    } catch (error) {
      try { fs.unlinkSync(filepath); } catch {}
      throw error;
    }
  }

`;

server = server.replace(routeAnchor, voiceRoute + routeAnchor);

/* FRONTEND: microphone button */
const attachAnchor =
  '<button type="button" class="icon-btn" id="attachBtn">＋</button>';

need(html.includes(attachAnchor), 'Composer attachment button not found.');

html = html.replace(
  attachAnchor,
  attachAnchor +
  '\n    <button type="button" class="icon-btn" id="voiceBtn" aria-label="Record voice note">🎙</button>'
);

/* FRONTEND: voice message styles */
html = replaceOnce(
  html,
  /<\/style>/,
  `
/* VOICE_NOTES_FEATURE */
#voiceBtn { min-width:44px; touch-action:manipulation; }
#voiceBtn.recording { color:#ff5252; background:rgba(255,82,82,.13); }
.voice-player { display:block; width:min(240px,65vw); max-width:100%; margin:5px 0; }
.voice-label { font-size:12px; opacity:.8; margin-bottom:4px; }
</style>`,
  'style closing tag'
);

/* FRONTEND: preserve voice metadata when loading messages */
html = replaceOnce(
  html,
  /localMessages\[id\]\s*=\s*\(result\.messages\s*\|\|\s*\[\]\)\.map\(m\s*=>\s*\(\{\s*text:\s*m\.body,\s*time:\s*new Date\(m\.created_at\)\.toLocaleTimeString\(\[\],\s*\{hour:"2-digit",minute:"2-digit"\}\),\s*out:\s*String\(m\.user_id\)\s*===\s*String\(currentUser\.id\),\s*read:\s*Boolean\(m\.read_at\)\s*\}\)\);/,
  `localMessages[id] = (result.messages || []).map(m => ({
      text: m.body,
      time: new Date(m.created_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}),
      out: String(m.user_id) === String(currentUser.id),
      read: Boolean(m.read_at),
      type: m.type || "text",
      media_url: m.media_url || "",
      media_mime: m.media_mime || "",
      duration: Number(m.duration) || 0
    }));`,
  'message loading mapper'
);

/* FRONTEND: render audio safely with native controls */
const renderAnchor =
  `    el.innerHTML = '<div>' + escapeHtml(msg.text) + '</div><div class="message-time">' + escapeHtml(msg.time) + (msg.out ? (msg.read ? ' <span class="read-tick">✓✓</span>' : ' ✓') : '') + '</div>';`;

need(html.includes(renderAnchor), 'Message rendering anchor not found.');

html = html.replace(
  renderAnchor,
  `    if (msg.type === "voice" && msg.media_url) {
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
    } else {
      const body = document.createElement("div");
      body.textContent = msg.text;
      el.appendChild(body);
    }
    const time = document.createElement("div");
    time.className = "message-time";
    time.textContent = msg.time;
    if (msg.out) {
      time.innerHTML += msg.read
        ? ' <span class="read-tick">✓✓</span>' : ' ✓';
    }
    el.appendChild(time);`
);

/* FRONTEND: recorder logic */
const composerAnchor = '/* COMPOSER */';
need(html.includes(composerAnchor), 'Composer script anchor not found.');

const recorderCode = `
/* VOICE_NOTES_FEATURE: recorder */
let voiceRecorder = null;
let voiceStream = null;
let voiceChunks = [];
let voiceStartedAt = 0;
let voiceClock = null;
let voiceStarting = false;

async function startVoiceRecording() {
  if (voiceStarting || voiceRecorder) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia ||
      typeof MediaRecorder === "undefined") {
    toast("Voice recording is not supported by this browser.");
    return;
  }

  voiceStarting = true;
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({audio:true});
    const types = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
    const mime = types.find(t => MediaRecorder.isTypeSupported(t));
    voiceRecorder = mime
      ? new MediaRecorder(voiceStream, {mimeType:mime})
      : new MediaRecorder(voiceStream);

    voiceChunks = [];
    voiceRecorder.ondataavailable = e => {
      if (e.data && e.data.size) voiceChunks.push(e.data);
    };

    voiceRecorder.onstop = async () => {
      clearInterval(voiceClock);
      const recorder = voiceRecorder;
      const stream = voiceStream;
      voiceRecorder = null;
      voiceStream = null;

      if (stream) stream.getTracks().forEach(track => track.stop());

      const blob = new Blob(voiceChunks, {
        type: recorder.mimeType || "audio/webm"
      });
      const duration = Math.min(120, (Date.now() - voiceStartedAt) / 1000);
      voiceChunks = [];

      $("voiceBtn").classList.remove("recording");
      $("voiceBtn").textContent = "🎙";
      $("voiceBtn").disabled = false;

      if (!blob.size) {
        toast("No audio was recorded.");
        return;
      }
      if (blob.size > 2 * 1024 * 1024) {
        toast("Voice note is too large. Please record a shorter note.");
        return;
      }
      if (!currentChat) return;

      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const base64 = String(reader.result).split(",")[1];
          await api("/api/chats/" + currentChat.id + "/voice", {
            method:"POST",
            body:JSON.stringify({
              audio:base64,
              mime:blob.type || "audio/webm",
              duration
            })
          });
          await loadMessages(currentChat.id);
          await loadChats();
          buzz(18);
        } catch (error) {
          toast(error.message || "Could not send voice note.");
        }
      };
      reader.onerror = () => toast("Could not read the recording.");
      reader.readAsDataURL(blob);
    };

    voiceRecorder.start();
    voiceStartedAt = Date.now();
    $("voiceBtn").classList.add("recording");
    $("voiceBtn").textContent = "⏹";
    toast("Recording... tap the stop button to send.");

    voiceClock = setInterval(() => {
      if (!voiceRecorder) return;
      const seconds = Math.floor((Date.now() - voiceStartedAt) / 1000);
      if (seconds >= 120) {
        toast("Two-minute recording limit reached.");
        stopVoiceRecording();
      }
    }, 500);
  } catch (error) {
    if (voiceStream) voiceStream.getTracks().forEach(t => t.stop());
    voiceStream = null;
    voiceRecorder = null;
    toast("Microphone unavailable. Please allow microphone access.");
  } finally {
    voiceStarting = false;
  }
}

function stopVoiceRecording() {
  if (voiceRecorder && voiceRecorder.state !== "inactive") {
    voiceRecorder.stop();
  }
}

$("voiceBtn").addEventListener("click", () => {
  if (voiceRecorder) stopVoiceRecording();
  else startVoiceRecording();
});

`;

html = html.replace(composerAnchor, recorderCode + composerAnchor);

/* Validate everything before writing files */
new vm.Script(server, {filename:'server.js'});
const scriptTags = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
need(scriptTags.length > 0, 'No frontend script found.');

for (let i = 0; i < scriptTags.length; i++) {
  new vm.Script(scriptTags[i][1], {filename:'index.html script ' + i});
}

/* Back up, then write */
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.copyFileSync(serverPath, serverPath + '.backup-' + stamp);
fs.copyFileSync(htmlPath, htmlPath + '.backup-' + stamp);

fs.writeFileSync(serverPath, server);
fs.writeFileSync(htmlPath, html);

console.log('VOICE NOTES INSTALLED SUCCESSFULLY');
console.log('Backups created with suffix: ' + stamp);
console.log('Backend and frontend JavaScript syntax checks passed.');
