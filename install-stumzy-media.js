'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const server = path.join(__dirname, 'server.js');
let src = fs.readFileSync(server, 'utf8');

function check(ok, message) {
  if (!ok) throw new Error(message);
}

check(src.includes('const messagesMatch = pathname.match('),
  'Messages route not found.');
check(src.includes('  // DELETE MESSAGE'),
  'Delete-message route not found.');
check(src.includes('  // DELETE CHAT FROM YOUR CHAT LIST'),
  'Delete-chat route not found.');
check(!src.includes('STUMZY_MEDIA_V2_INSTALLED'),
  'This upgrade is already installed.');

const migration = [
  'CREATE TABLE IF NOT EXISTS message_hidden (',
  'message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,',
  'user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,',
  'PRIMARY KEY(message_id,user_id));',
  'CREATE TABLE IF NOT EXISTS stories (',
  'id INTEGER PRIMARY KEY AUTOINCREMENT,',
  'user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,',
  'media_url TEXT NOT NULL, media_mime TEXT NOT NULL,',
  'type TEXT NOT NULL, caption TEXT DEFAULT \'\',',
  'created_at TEXT DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL);',
  'CREATE INDEX IF NOT EXISTS stories_expiry_idx ON stories(expires_at);',
  'CREATE TABLE IF NOT EXISTS typing_status (',
  'chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,',
  'user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,',
  'updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,',
  'PRIMARY KEY(chat_id,user_id));'
].join('\n');

const routes = String.raw`
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
`;

const deleteStart = src.indexOf('  // DELETE MESSAGE');
const deleteEnd = src.indexOf(
  '  // DELETE CHAT FROM YOUR CHAT LIST', deleteStart
);

check(deleteStart >= 0 && deleteEnd > deleteStart,
  'Could not safely locate delete-message section.');

const deleteRoute = String.raw`  // DELETE MESSAGE: delete for me or everyone
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

`;

src = src.slice(0, deleteStart) + deleteRoute + src.slice(deleteEnd);

// Hide messages deleted for the current user.
const queryPattern =
  /WHERE m\.chat_id=\? AND m\.id>\?\s+ORDER BY m\.id ASC LIMIT 100\s+\`\)\.all\(chatId, after\);/g;

check((src.match(queryPattern) || []).length === 1,
  'Could not safely locate the message-list SQL query.');

src = src.replace(queryPattern,
  "WHERE m.chat_id=? AND m.id>? " +
  "AND NOT EXISTS (SELECT 1 FROM message_hidden h " +
  "WHERE h.message_id=m.id AND h.user_id=?) " +
  "ORDER BY m.id ASC LIMIT 100\n    `).all(chatId, after, user.id);"
);

// Insert new routes before existing message routes.
const messageAnchor = '  const messagesMatch = pathname.match(';
const messageAt = src.indexOf(messageAnchor);

check(messageAt >= 0, 'Message route insertion point not found.');

src = src.slice(0, messageAt) + routes + '\n' + src.slice(messageAt);

// Add database migrations before PORT.
const portAnchor = 'const PORT = 3000;';
const portAt = src.indexOf(portAnchor);

check(portAt >= 0, 'PORT declaration not found.');

src = src.slice(0, portAt) +
  '/* STUMZY_MEDIA_V2_MIGRATION */\ndb.exec(' +
  JSON.stringify(migration) + ');\n\n' +
  src.slice(portAt);

// Validate the resulting server before replacing the original.
const temp = server + '.check-temp.js';
fs.writeFileSync(temp, src);

const result = spawnSync(process.execPath, ['--check', temp], {
  encoding: 'utf8'
});

if (result.status !== 0) {
  try { fs.unlinkSync(temp); } catch {}
  console.error('SERVER SYNTAX CHECK FAILED. Original server.js was not changed.');
  console.error(result.stderr || result.stdout);
  process.exit(1);
}

const backup = server + '.backup-' +
  new Date().toISOString().replace(/[:.]/g, '-');

fs.copyFileSync(server, backup);
fs.renameSync(temp, server);

console.log('STUMZY media, stories and typing backend installed.');
console.log('Server syntax check passed.');
console.log('Backup: ' + path.basename(backup));
console.log('Existing voice-note code preserved.');
