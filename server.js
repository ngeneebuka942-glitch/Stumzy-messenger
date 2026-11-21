const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, 'stumzy.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(chat_id,user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  edited_at TEXT
);

CREATE INDEX IF NOT EXISTS messages_chat_idx ON messages(chat_id,id);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
`);

// Safe database migration for existing installations
try {
  db.exec('ALTER TABLE users ADD COLUMN profile_picture TEXT DEFAULT NULL');
} catch {}

// PRESENCE FEATURE: safe migration
try {
  db.exec('ALTER TABLE users ADD COLUMN last_seen_at TEXT DEFAULT NULL');
} catch {}
try {
  db.exec('ALTER TABLE messages ADD COLUMN read_at TEXT DEFAULT NULL');
} catch {}
try { db.exec("ALTER TABLE users ADD COLUMN last_seen_visibility TEXT NOT NULL DEFAULT 'everyone'"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN profile_visibility TEXT NOT NULL DEFAULT 'everyone'"); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN read_receipts INTEGER NOT NULL DEFAULT 1'); } catch {}


/* STUMZY_MEDIA_V2_MIGRATION */
db.exec("CREATE TABLE IF NOT EXISTS message_hidden (\nmessage_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,\nuser_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,\nPRIMARY KEY(message_id,user_id));\nCREATE TABLE IF NOT EXISTS stories (\nid INTEGER PRIMARY KEY AUTOINCREMENT,\nuser_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,\nmedia_url TEXT NOT NULL, media_mime TEXT NOT NULL,\ntype TEXT NOT NULL, caption TEXT DEFAULT '',\ncreated_at TEXT DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL);\nCREATE INDEX IF NOT EXISTS stories_expiry_idx ON stories(expires_at);\nCREATE TABLE IF NOT EXISTS typing_status (\nchat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,\nuser_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,\nupdated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\nPRIMARY KEY(chat_id,user_id));");

const PORT = 3000;
const publicDir = path.join(__dirname, 'public');
/* VOICE_NOTES_FEATURE: database migration */
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

const uploadsDir = path.join(publicDir, 'uploads');

fs.mkdirSync(uploadsDir, { recursive: true });

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)')
    .run(tokenHash(token), userId, Date.now() + 30 * 86400000);
  return token;
}

function getUser(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return null;

  return db.prepare(`
    SELECT u.id,u.username,u.display_name,u.profile_picture
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?
  `).get(tokenHash(token), Date.now()) || null;
}

function readBody(req, limit = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function requireUser(req, res) {
  const user = getUser(req);
  if (!user) send(res, 401, { error: 'Please log in.' });
  return user;
}

function isMember(chatId, userId) {
  return !!db.prepare(
    'SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?'
  ).get(chatId, userId);
}

function validId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const method = req.method;
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/health') {
    return send(res, 200, {
      status: 'ok',
      app: 'STUMZY',
      database: 'sqlite',
      version: 3
    });
  }

  // REGISTER
  if (method === 'POST' && pathname === '/api/register') {
    const b = await readBody(req);
    const username = String(b.username || '').trim().toLowerCase();
    const display = String(b.displayName || username).trim();
    const password = String(b.password || '');

    if (!/^[a-z0-9_]{3,24}$/.test(username))
      return send(res, 400, { error: 'Username: 3-24 letters, numbers or underscores.' });

    if (password.length < 8)
      return send(res, 400, { error: 'Password must be at least 8 characters.' });

    if (!display || display.length > 40)
      return send(res, 400, { error: 'Display name must be 1-40 characters.' });

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');

    try {
      const result = db.prepare(`
        INSERT INTO users(username,display_name,salt,password_hash)
        VALUES(?,?,?,?)
      `).run(username, display, salt, hash);

      const user = {
        id: Number(result.lastInsertRowid),
        username,
        display_name: display,
        profile_picture: null
      };

      return send(res, 201, { user, token: createSession(user.id) });
    } catch {
      return send(res, 409, { error: 'Username already exists.' });
    }
  }

  // LOGIN
  if (method === 'POST' && pathname === '/api/login') {
    const b = await readBody(req);
    const username = String(b.username || '').trim().toLowerCase();
    const password = String(b.password || '');

    const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (!user) return send(res, 401, { error: 'Invalid username or password.' });

    const hash = crypto.scryptSync(password, user.salt, 64);
    const expected = Buffer.from(user.password_hash, 'hex');

    if (hash.length !== expected.length ||
        !crypto.timingSafeEqual(hash, expected)) {
      return send(res, 401, { error: 'Invalid username or password.' });
    }

    return send(res, 200, {
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        profile_picture: user.profile_picture
      },
      token: createSession(user.id)
    });
  }

  // PRESENCE FEATURE
  if (method === 'POST' && pathname === '/api/presence') {
    const user = requireUser(req, res);
    if (!user) return;
    db.prepare("UPDATE users SET last_seen_at=datetime('now') WHERE id=?").run(user.id);
    return send(res, 200, { success: true });
  }

  // CURRENT USER
  if (method === 'GET' && pathname === '/api/me') {
    const user = requireUser(req, res);
    if (!user) return;
    return send(res, 200, { user });
  }

  // LOGOUT
  if (method === 'POST' && pathname === '/api/logout') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (token) {
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
    }
    return send(res, 200, { success: true });
  }

  // SEARCH USERS
  if (method === 'GET' && pathname === '/api/users/search') {
    const user = requireUser(req, res);
    if (!user) return;

    const q = String(url.searchParams.get('q') || '')
      .trim().replace(/^@/, '').toLowerCase();

    if (q.length < 2) return send(res, 200, { users: [] });

    const users = db.prepare(`
      SELECT id,username,display_name,profile_picture
      FROM users
      WHERE id<>? AND username LIKE ? ESCAPE '\\'
      ORDER BY username
      LIMIT 30
    `).all(user.id, '%' + q.replace(/[\\%_]/g, '\\$&') + '%');

    return send(res, 200, { users });
  }

  // UPDATE PROFILE PICTURE
  if (method === 'POST' && pathname === '/api/profile/avatar') {
    const user = requireUser(req, res);
    if (!user) return;

    const b = await readBody(req, 3 * 1024 * 1024);
    const image = String(b.image || '');

    const match = image.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
      return send(res, 400, { error: 'Please upload a JPG, PNG or WebP image.' });
    }

    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > 2 * 1024 * 1024) {
      return send(res, 400, { error: 'Image must be under 2 MB.' });
    }

    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const filename = user.id + '-' + crypto.randomBytes(12).toString('hex') + '.' + ext;
    const filepath = path.join(uploadsDir, filename);

    fs.writeFileSync(filepath, buffer);

    const old = db.prepare('SELECT profile_picture FROM users WHERE id=?').get(user.id);
    db.prepare('UPDATE users SET profile_picture=? WHERE id=?')
      .run('/uploads/' + filename, user.id);

    if (old?.profile_picture?.startsWith('/uploads/')) {
      const oldPath = path.join(uploadsDir, path.basename(old.profile_picture));
      if (oldPath !== filepath) {
        try { fs.unlinkSync(oldPath); } catch {}
      }
    }

    return send(res, 200, {
      success: true,
      profile_picture: '/uploads/' + filename
    });
  }

  // REMOVE PROFILE PICTURE
  if (method === 'DELETE' && pathname === '/api/profile/avatar') {
    const user = requireUser(req, res);
    if (!user) return;

    const old = db.prepare('SELECT profile_picture FROM users WHERE id=?').get(user.id);
    db.prepare('UPDATE users SET profile_picture=NULL WHERE id=?').run(user.id);

    if (old?.profile_picture?.startsWith('/uploads/')) {
      try {
        fs.unlinkSync(path.join(uploadsDir, path.basename(old.profile_picture)));
      } catch {}
    }

    return send(res, 200, { success: true });
  }

  // CREATE OR OPEN PRIVATE CHAT
  if (method === 'POST' && pathname === '/api/chats') {
    const user = requireUser(req, res);
    if (!user) return;

    const b = await readBody(req);
    const otherId = validId(b.userId);

    if (!otherId || otherId === user.id)
      return send(res, 400, { error: 'Choose another user.' });

    const other = db.prepare('SELECT id FROM users WHERE id=?').get(otherId);
    if (!other) return send(res, 404, { error: 'User not found.' });

    const existing = db.prepare(`
      SELECT c.id
      FROM chats c
      JOIN chat_members a ON a.chat_id=c.id AND a.user_id=?
      JOIN chat_members b ON b.chat_id=c.id AND b.user_id=?
      WHERE (SELECT COUNT(*) FROM chat_members m WHERE m.chat_id=c.id)=2
      ORDER BY c.id DESC LIMIT 1
    `).get(user.id, otherId);

    if (existing) return send(res, 200, { chatId: existing.id });

    const result = db.prepare('INSERT INTO chats(title) VALUES(?)').run('');
    const chatId = Number(result.lastInsertRowid);

    const insertMember = db.prepare(
      'INSERT INTO chat_members(chat_id,user_id) VALUES(?,?)'
    );

    insertMember.run(chatId, user.id);
    insertMember.run(chatId, otherId);

    return send(res, 201, { chatId });
  }


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

  // LIST CHATS
  if (method === 'GET' && pathname === '/api/chats') {
    const user = requireUser(req, res);
    if (!user) return;

    const chats = db.prepare(`
      SELECT
        c.id,
        c.created_at,
        u.id AS other_user_id,
        u.username AS other_username,
        u.display_name AS other_display_name,
        CASE WHEN u.profile_visibility='nobody' THEN NULL ELSE u.profile_picture END AS other_profile_picture,
        CASE WHEN u.last_seen_visibility='nobody' THEN NULL ELSE u.last_seen_at END AS last_seen_at,
        CASE WHEN u.last_seen_visibility='nobody' THEN 0
             WHEN u.last_seen_at >= datetime('now','-45 seconds') THEN 1 ELSE 0 END AS online,

        m.created_at AS last_message_at,
        m.user_id AS last_message_user_id,
        m.id AS last_message_id,
        (SELECT COUNT(*) FROM messages unread WHERE unread.chat_id=c.id AND unread.user_id<>? AND unread.read_at IS NULL) AS unread_count
      FROM chats c
      JOIN chat_members mine ON mine.chat_id=c.id AND mine.user_id=?
      JOIN chat_members other ON other.chat_id=c.id AND other.user_id<>?
      JOIN users u ON u.id=other.user_id
      LEFT JOIN messages m ON m.id=(
        SELECT id FROM messages WHERE chat_id=c.id ORDER BY id DESC LIMIT 1
      )
      ORDER BY COALESCE(m.id,0) DESC, c.id DESC
    `).all(user.id, user.id, user.id);

    return send(res, 200, { chats });
  }

  // GET CHAT MESSAGES

  /* VOICE_NOTES_FEATURE: upload voice message */
  const voiceMatch = pathname.match(/^\/api\/chats\/(\d+)\/voice$/);

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

      const message = db.prepare(`
        SELECT m.id,m.chat_id,m.user_id,m.body,m.created_at,
               m.edited_at,m.read_at,m.type,m.media_url,m.media_mime,m.duration,
               u.username,u.display_name,u.profile_picture
        FROM messages m JOIN users u ON u.id=m.user_id
        WHERE m.id=?
      `).get(Number(result.lastInsertRowid));

      return send(res, 201, { message });
    } catch (error) {
      try { fs.unlinkSync(filepath); } catch {}
      throw error;
    }
  }


  /* STUMZY_MEDIA_V2_INSTALLED */

  // CHAT ATTACHMENTS
  const attachmentMatch = pathname.match(/^\/api\/chats\/(\d+)\/attachments$/);

  if (method === 'POST' && attachmentMatch) {
    const user = requireUser(req, res);
    if (!user) return;

    const chatId = validId(attachmentMatch[1]);
    if (!chatId || !isMember(chatId, user.id))
      return send(res, 403, { error: 'Conversation unavailable.' });

    const b = await readBody(req, 12 * 1024 * 1024);
    const mime = String(b.mime || '').split(';')[0].toLowerCase();

    const allowed = {
      'image/jpeg': ['jpg', 'image'],
      'image/png': ['png', 'image'],
      'image/webp': ['webp', 'image'],
      'image/gif': ['gif', 'image'],
      'video/mp4': ['mp4', 'video'],
      'video/webm': ['webm', 'video'],
      'application/pdf': ['pdf', 'document'],
      'text/plain': ['txt', 'document'],
      'application/zip': ['zip', 'document'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx', 'document'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx', 'document']
    };

    if (!allowed[mime])
      return send(res, 400, { error: 'Unsupported attachment type.' });

    if (typeof b.data !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(b.data))
      return send(res, 400, { error: 'Invalid file data.' });

    const buffer = Buffer.from(b.data, 'base64');
    if (!buffer.length || buffer.length > 8 * 1024 * 1024)
      return send(res, 400, { error: 'File must be under 8 MB.' });

    const kind = allowed[mime][1];
    const filename = 'attachment-' +
      crypto.randomBytes(16).toString('hex') + '.' + allowed[mime][0];
    const filepath = path.join(uploadsDir, filename);

    fs.writeFileSync(filepath, buffer, { flag: 'wx' });

    const caption = String(b.caption || '').trim().slice(0, 1000);
    const labels = { image: 'Photo', video: 'Video', document: 'Document' };

    try {
      const result = db.prepare(
        'INSERT INTO messages(chat_id,user_id,body,type,media_url,media_mime) VALUES(?,?,?,?,?,?)'
      ).run(chatId, user.id, caption || labels[kind], kind,
        '/uploads/' + filename, mime);

      return send(res, 201, {
        success: true,
        messageId: Number(result.lastInsertRowid)
      });
    } catch (error) {
      try { fs.unlinkSync(filepath); } catch {}
      throw error;
    }
  }

  // CREATE STORY
  if (method === 'POST' && pathname === '/api/stories') {
    const user = requireUser(req, res);
    if (!user) return;

    const b = await readBody(req, 12 * 1024 * 1024);
    const mime = String(b.mime || '').split(';')[0].toLowerCase();

    const allowed = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'video/webm': 'webm'
    };

    if (!allowed[mime])
      return send(res, 400, { error: 'Stories support photos and videos only.' });

    if (typeof b.data !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(b.data))
      return send(res, 400, { error: 'Invalid story data.' });

    const buffer = Buffer.from(b.data, 'base64');
    if (!buffer.length || buffer.length > 8 * 1024 * 1024)
      return send(res, 400, { error: 'Story must be under 8 MB.' });

    const filename = 'story-' +
      crypto.randomBytes(16).toString('hex') + '.' + allowed[mime];
    const filepath = path.join(uploadsDir, filename);

    fs.writeFileSync(filepath, buffer, { flag: 'wx' });

    try {
      const result = db.prepare(
        "INSERT INTO stories(user_id,media_url,media_mime,type,caption,expires_at) " +
        "VALUES(?,?,?,?,?,datetime('now','+1 day'))"
      ).run(user.id, '/uploads/' + filename, mime,
        mime.startsWith('video/') ? 'video' : 'image',
        String(b.caption || '').trim().slice(0, 500));

      return send(res, 201, {
        success: true,
        storyId: Number(result.lastInsertRowid),
        expiresInHours: 24
      });
    } catch (error) {
      try { fs.unlinkSync(filepath); } catch {}
      throw error;
    }
  }

  // LIST ACTIVE STORIES
  if (method === 'GET' && pathname === '/api/stories') {
    const user = requireUser(req, res);
    if (!user) return;

    const stories = db.prepare(
      'SELECT s.id,s.user_id,s.media_url,s.media_mime,s.type,s.caption,' +
      's.created_at,s.expires_at,u.username,u.display_name,u.profile_picture ' +
      'FROM stories s JOIN users u ON u.id=s.user_id ' +
      'WHERE s.expires_at>CURRENT_TIMESTAMP AND (' +
      's.user_id=? OR EXISTS (' +
      'SELECT 1 FROM chat_members a JOIN chat_members b ON a.chat_id=b.chat_id ' +
      'WHERE a.user_id=? AND b.user_id=s.user_id)) ' +
      'ORDER BY s.created_at DESC'
    ).all(user.id, user.id);

    return send(res, 200, { stories });
  }

  // DELETE OWN STORY
  const storyMatch = pathname.match(/^\/api\/stories\/(\d+)$/);

  if (method === 'DELETE' && storyMatch) {
    const user = requireUser(req, res);
    if (!user) return;

    const story = db.prepare('SELECT * FROM stories WHERE id=?')
      .get(validId(storyMatch[1]));

    if (!story || story.user_id !== user.id)
      return send(res, 403, { error: 'You cannot delete this story.' });

    db.prepare('DELETE FROM stories WHERE id=?').run(story.id);

    try {
      fs.unlinkSync(path.join(uploadsDir, path.basename(story.media_url)));
    } catch {}

    return send(res, 200, { success: true });
  }

  // TYPING INDICATORS
  const typingMatch = pathname.match(/^\/api\/chats\/(\d+)\/typing$/);

  if (typingMatch) {
    const user = requireUser(req, res);
    if (!user) return;

    const chatId = validId(typingMatch[1]);
    if (!chatId || !isMember(chatId, user.id))
      return send(res, 403, { error: 'Conversation unavailable.' });

    if (method === 'POST') {
      const b = await readBody(req);

      if (b.typing === false) {
        db.prepare(
          'DELETE FROM typing_status WHERE chat_id=? AND user_id=?'
        ).run(chatId, user.id);
      } else {
        db.prepare(
          'INSERT INTO typing_status(chat_id,user_id,updated_at) ' +
          'VALUES(?,?,CURRENT_TIMESTAMP) ' +
          'ON CONFLICT(chat_id,user_id) DO UPDATE SET updated_at=CURRENT_TIMESTAMP'
        ).run(chatId, user.id);
      }

      return send(res, 200, { success: true });
    }

    if (method === 'GET') {
      const typing = db.prepare(
        'SELECT u.id,u.username,u.display_name ' +
        'FROM typing_status t JOIN users u ON u.id=t.user_id ' +
        'WHERE t.chat_id=? AND t.user_id<>? ' +
        "AND datetime(t.updated_at)>datetime('now','-8 seconds')"
      ).all(chatId, user.id);

      return send(res, 200, { typing });
    }
  }

  const messagesMatch = pathname.match(/^\/api\/chats\/(\d+)\/messages$/);

  if (method === 'GET' && messagesMatch) {
    const user = requireUser(req, res);
    if (!user) return;

    const chatId = validId(messagesMatch[1]);
    if (!chatId || !isMember(chatId, user.id))
      return send(res, 403, { error: 'Conversation unavailable.' });

    const privacy = db.prepare('SELECT read_receipts FROM users WHERE id=?').get(user.id);
    if (privacy && privacy.read_receipts) {
      db.prepare('UPDATE messages SET read_at=CURRENT_TIMESTAMP WHERE chat_id=? AND user_id<>? AND read_at IS NULL').run(chatId, user.id);
    }

    const after = validId(url.searchParams.get('after')) || 0;

    const messages = db.prepare(`
      SELECT m.id,m.chat_id,m.user_id,m.body,m.created_at,m.edited_at,m.read_at,m.type,m.media_url,m.media_mime,m.duration,
             u.username,u.display_name,u.profile_picture
      FROM messages m JOIN users u ON u.id=m.user_id
      WHERE m.chat_id=? AND m.id>? AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=?) ORDER BY m.id ASC LIMIT 100
    `).all(chatId, after, user.id);

    return send(res, 200, { messages });
  }

  // SEND MESSAGE
  if (method === 'POST' && messagesMatch) {
    const user = requireUser(req, res);
    if (!user) return;

    const chatId = validId(messagesMatch[1]);
    if (!chatId || !isMember(chatId, user.id))
      return send(res, 403, { error: 'Conversation unavailable.' });

    const b = await readBody(req);
    const body = String(b.body ?? '').trim();

    if (!body) return send(res, 400, { error: 'Message cannot be empty.' });
    if (body.length > 4000)
      return send(res, 400, { error: 'Message is too long (maximum 4000 characters).' });

    const result = db.prepare(
      'INSERT INTO messages(chat_id,user_id,body) VALUES(?,?,?)'
    ).run(chatId, user.id, body);

    const message = db.prepare(`
      SELECT m.id,m.chat_id,m.user_id,m.body,m.created_at,m.edited_at,m.read_at,m.type,m.media_url,m.media_mime,m.duration,
             u.username,u.display_name,u.profile_picture
      FROM messages m JOIN users u ON u.id=m.user_id
      WHERE m.id=?
    `).get(Number(result.lastInsertRowid));

    return send(res, 201, { message });
  }

  // EDIT MESSAGE
  const editMatch = pathname.match(/^\/api\/messages\/(\d+)$/);

  if (method === 'PATCH' && editMatch) {
    const user = requireUser(req, res);
    if (!user) return;

    const messageId = validId(editMatch[1]);
    const b = await readBody(req);
    const body = String(b.body ?? '').trim();

    if (!body || body.length > 4000)
      return send(res, 400, { error: 'Message must be 1-4000 characters.' });

    const message = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
    if (!message || message.user_id !== user.id)
      return send(res, 403, { error: 'You cannot edit this message.' });

    db.prepare('UPDATE messages SET body=?,edited_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(body, messageId);

    return send(res, 200, { success: true });
  }

  // DELETE MESSAGE: delete for me or everyone
  if (method === 'DELETE' && editMatch) {
    const user = requireUser(req, res);
    if (!user) return;

    const messageId = validId(editMatch[1]);
    const message = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);

    if (!message || !isMember(message.chat_id, user.id))
      return send(res, 404, { error: 'Message not found.' });

    const b = await readBody(req);
    const scope = b.scope || 'everyone';

    if (scope === 'me') {
      db.prepare(
        'INSERT OR IGNORE INTO message_hidden(message_id,user_id) VALUES(?,?)'
      ).run(messageId, user.id);

      return send(res, 200, { success: true, scope: 'me' });
    }

    if (scope !== 'everyone')
      return send(res, 400, { error: 'Invalid delete scope.' });

    if (message.user_id !== user.id)
      return send(res, 403, {
        error: 'Only the sender can delete this message for everyone.'
      });

    db.prepare(
      "UPDATE messages SET body='This message was deleted'," +
      "type='deleted',media_url=NULL,media_mime=NULL,duration=NULL WHERE id=?"
    ).run(messageId);

    db.prepare('DELETE FROM message_hidden WHERE message_id=?')
      .run(messageId);

    return send(res, 200, { success: true, scope: 'everyone' });
  }

  // DELETE CHAT FROM YOUR CHAT LIST
  const chatMatch = pathname.match(/^\/api\/chats\/(\d+)$/);

  if (method === 'DELETE' && chatMatch) {
    const user = requireUser(req, res);
    if (!user) return;

    const chatId = validId(chatMatch[1]);
    if (!chatId || !isMember(chatId, user.id))
      return send(res, 403, { error: 'Conversation unavailable.' });

    db.prepare('DELETE FROM chat_members WHERE chat_id=? AND user_id=?')
      .run(chatId, user.id);

    const remaining = db.prepare(
      'SELECT COUNT(*) AS n FROM chat_members WHERE chat_id=?'
    ).get(chatId).n;

    if (!remaining) db.prepare('DELETE FROM chats WHERE id=?').run(chatId);

    return send(res, 200, { success: true });
  }

  if (pathname.startsWith('/api/'))
    return send(res, 404, { error: 'API endpoint not found.' });

  // STATIC FILES
  let file = pathname === '/' ? 'index.html' : pathname.slice(1);
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(publicDir, file);

  if (!full.startsWith(publicDir))
    return send(res, 403, { error: 'Forbidden.' });

  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, { error: 'File not found.' });

    const ext = path.extname(full);
    const types = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp'
    };

    res.writeHead(200, {
      'Content-Type': (types[ext] || 'application/octet-stream') + '; charset=utf-8',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  route(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Server error.' });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('STUMZY V2 running on port ' + PORT);
  console.log('Database: SQLite');
  console.log('Open http://localhost:' + PORT);
});
