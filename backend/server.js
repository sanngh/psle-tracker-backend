const path = require('path');
const fs = require('fs');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const { createClient } = require('@libsql/client');
const crypto = require('crypto');
const config = require('./config');
const { createMediaStorage } = require('./mediaStorage');
const { requireEvidenceLinking } = config;

const cloudProviderErrors = config.validateCloudProviders();
if (cloudProviderErrors.length > 0) {
  throw new Error(`Cloud provider configuration error:\n- ${cloudProviderErrors.join('\n- ')}`);
}
const mediaStorage = createMediaStorage(config);

const app = express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false,
  hidePoweredBy: true
}));

const allowedOrigins = new Set(config.corsOrigins.length > 0 ? config.corsOrigins : ['http://localhost:19006', 'http://localhost:8081', 'http://127.0.0.1:19006']);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    callback(new Error('CORS origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: config.maxJsonPayloadBytes }));
app.use(express.urlencoded({ extended: true, limit: config.maxJsonPayloadBytes }));

const apiLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait before retrying.' }
});
app.use('/api', apiLimiter);

// Tighter limiter for phone-lookup/PIN endpoints, keyed by IP+phone so a rotating-IP horizontal
// scan across many phone numbers is still throttled per number, not just per source IP.
const authLookupLimiter = rateLimit({
  windowMs: config.authRateLimitWindowMs,
  max: config.authRateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${String(req.body?.userKey || '').trim()}`,
  message: { error: 'Too many attempts for this account. Please wait before retrying.' }
});
app.use('/api/auth/check', authLookupLimiter);
app.use('/api/auth/pin/verify', authLookupLimiter);

const uploadsDir = config.uploadsDir;
if (mediaStorage.provider === 'local' && !fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir, {
  maxAge: '1h',
  index: false,
  redirect: false
}));

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadBytes }
});

const dbPath = config.dbPath;
const useSqlite = config.useSqlite === true;

const createTursoDatabase = () => {
  const tursoUrl = config.tursoDatabaseUrl || 'file:./data/local.db';
  const authToken = config.tursoAuthToken || undefined;

  if (tursoUrl.startsWith('file:')) {
    const filePath = tursoUrl.replace(/^file:/, '').replace(/^\/+/, '');
    const dataDir = path.resolve(__dirname, filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '.');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  const toSafeNumber = (value) => {
    if (typeof value !== 'bigint') return value;
    return value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER ? Number(value) : value.toString();
  };
  const sanitizeRow = (row) => {
    if (!row || typeof row !== 'object') return row;
    const clean = {};
    for (const key of Object.keys(row)) clean[key] = toSafeNumber(row[key]);
    return clean;
  };

  const client = createClient({ url: tursoUrl, authToken });
  const db = {
    _queue: Promise.resolve(),
    _enqueue(operation) {
      const next = this._queue.then(() => new Promise((resolve, reject) => operation(resolve, reject)));
      this._queue = next.catch(() => undefined);
      return next;
    },
    serialize(fn) {
      return this._enqueue((resolve, reject) => {
        try {
          fn();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    },
    get(sql, params, callback) {
      const finalCallback = typeof params === 'function' ? params : callback;
      const args = Array.isArray(params) ? params : [];
      return this._enqueue((resolve, reject) => {
        client.execute({ sql, args })
          .then((result) => {
            const row = result.rows && result.rows[0] ? sanitizeRow(result.rows[0]) : undefined;
            if (finalCallback) finalCallback(null, row);
            resolve(row);
          })
          .catch((error) => {
            if (finalCallback) finalCallback(error);
            reject(error);
          });
      });
    },
    all(sql, params, callback) {
      const finalCallback = typeof params === 'function' ? params : callback;
      const args = Array.isArray(params) ? params : [];
      return this._enqueue((resolve, reject) => {
        client.execute({ sql, args })
          .then((result) => {
            const rows = (result.rows || []).map(sanitizeRow);
            if (finalCallback) finalCallback(null, rows);
            resolve(rows);
          })
          .catch((error) => {
            if (finalCallback) finalCallback(error);
            reject(error);
          });
      });
    },
    run(sql, params, callback) {
      const finalCallback = typeof params === 'function' ? params : callback;
      const args = Array.isArray(params) ? params : [];
      return this._enqueue((resolve, reject) => {
        client.execute({ sql, args })
          .then((result) => {
            const meta = {
              lastID: toSafeNumber(result.lastInsertRowid ?? null),
              changes: toSafeNumber(result.rowsAffected ?? 0)
            };
            if (finalCallback) finalCallback.call(meta, null);
            resolve(meta);
          })
          .catch((error) => {
            if (finalCallback) finalCallback.call({ lastID: null, changes: 0 }, error);
            reject(error);
          });
      });
    },
    prepare(sql) {
      let statementQueue = Promise.resolve();
      return {
        run(...values) {
          const finalCallback = typeof values[values.length - 1] === 'function' ? values.pop() : null;
          const bindParams = values;
          statementQueue = statementQueue.then(() => new Promise((resolve, reject) => {
            db.run(sql, bindParams, function(err) {
              if (finalCallback) finalCallback.call(this, err);
              if (err) reject(err); else resolve(this);
            });
          }));
          return this;
        },
        finalize(callback) {
          statementQueue.then(() => {
            if (callback) callback();
          });
        }
      };
    },
    close() {
      return undefined;
    }
  };

  return db;
};

if (!useSqlite) {
  if (!config.tursoDatabaseUrl && !config.tursoAuthToken) {
    console.log('Using local Turso-compatible file database: ./data/local.db');
  } else if (config.tursoDatabaseUrl) {
    console.log('Using Turso database backend. SQLite is disabled unless USE_SQLITE=true.');
  }
}

const db = useSqlite
  ? new sqlite3.Database(dbPath, (err) => {
      if (err) console.error("Database connection failure:", err.message);
      else console.log(' Local SQLite Database loaded successfully: psle_tracker.db');
    })
  : createTursoDatabase();

const initializeDatabaseSchema = (database) => {
  if (!database) return;

  database.serialize(() => {
    database.run(`CREATE TABLE IF NOT EXISTS users (phone TEXT PRIMARY KEY, user_id INTEGER UNIQUE, created_at TEXT, role TEXT DEFAULT 'student', blocked INTEGER DEFAULT 0)`);
    database.run("ALTER TABLE users ADD COLUMN user_id INTEGER", () => {});
    database.run("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'student'", () => {});
    database.run("ALTER TABLE users ADD COLUMN blocked INTEGER DEFAULT 0", () => {});
    database.run("ALTER TABLE users ADD COLUMN pin_hash TEXT", () => {});
    database.run("ALTER TABLE users ADD COLUMN pin_salt TEXT", () => {});
    database.run("ALTER TABLE users ADD COLUMN pin_failed_attempts INTEGER DEFAULT 0", () => {});
    database.run("ALTER TABLE users ADD COLUMN pin_locked INTEGER DEFAULT 0", () => {});
    database.run("ALTER TABLE users ADD COLUMN avatar TEXT", () => {});
    database.run(`CREATE TABLE IF NOT EXISTS user_links (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_phone TEXT NOT NULL, student_phone TEXT NOT NULL, user_key TEXT, parent_user_id INTEGER, student_user_id INTEGER, created_at TEXT NOT NULL, UNIQUE(parent_phone, student_phone))`);
    database.run("ALTER TABLE user_links ADD COLUMN user_key TEXT", () => {});
    database.run("ALTER TABLE user_links ADD COLUMN parent_user_id INTEGER", () => {});
    database.run("ALTER TABLE user_links ADD COLUMN student_user_id INTEGER", () => {});
    database.run(`CREATE TABLE IF NOT EXISTS subject_hub (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, subject TEXT, level TEXT, confidence TEXT, progress INTEGER DEFAULT 0, alert_dismissed INTEGER DEFAULT 0, user_key TEXT, owner_user_id INTEGER)`);
    database.run("ALTER TABLE subject_hub ADD COLUMN owner_user_id INTEGER", () => {});
    database.run(`CREATE TABLE IF NOT EXISTS exam_tracker (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, subject TEXT, score INTEGER DEFAULT 0, total_score INTEGER DEFAULT 100, status TEXT DEFAULT 'Pending', assigned INTEGER DEFAULT 0, timer_seconds INTEGER DEFAULT 0, max_time_minutes INTEGER DEFAULT 90, alert_dismissed INTEGER DEFAULT 0, is_custom INTEGER DEFAULT 0, user_key TEXT, owner_user_id INTEGER)`);
    database.run("ALTER TABLE exam_tracker ADD COLUMN owner_user_id INTEGER", () => {});
    database.run("ALTER TABLE exam_tracker ADD COLUMN timer_seconds INTEGER DEFAULT 0", () => {});
    database.run("ALTER TABLE exam_tracker ADD COLUMN max_time_minutes INTEGER DEFAULT 90", () => {});
    database.run("ALTER TABLE exam_tracker ADD COLUMN is_custom INTEGER DEFAULT 0", () => {});
    database.run("UPDATE exam_tracker SET max_time_minutes = 90 WHERE max_time_minutes IS NULL OR max_time_minutes = 0", () => {});
    database.run(`CREATE TABLE IF NOT EXISTS mistakes_log (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, description TEXT, category TEXT, photo_url TEXT, status TEXT, revision_id INTEGER, exam_id INTEGER, user_key TEXT, owner_user_id INTEGER)`);
    database.run("ALTER TABLE mistakes_log ADD COLUMN owner_user_id INTEGER", () => {});
    database.run("ALTER TABLE mistakes_log ADD COLUMN description TEXT", () => {});
    database.run("ALTER TABLE mistakes_log ADD COLUMN revision_id INTEGER", () => {});
    database.run("ALTER TABLE mistakes_log ADD COLUMN exam_id INTEGER", () => {});
    database.run(`CREATE TABLE IF NOT EXISTS uploaded_files (id INTEGER PRIMARY KEY AUTOINCREMENT, mistake_id INTEGER, parent_phone_hash TEXT NOT NULL, month_folder TEXT NOT NULL, relative_path TEXT NOT NULL, original_name TEXT, uploaded_at TEXT NOT NULL, user_key TEXT NOT NULL, owner_user_id INTEGER)`);
    database.run("ALTER TABLE uploaded_files ADD COLUMN owner_user_id INTEGER", () => {});
    database.run(`CREATE TABLE IF NOT EXISTS teacher_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, month TEXT, subject TEXT, remarks TEXT, score INTEGER, user_key TEXT, owner_user_id INTEGER)`);
    database.run("ALTER TABLE teacher_feedback ADD COLUMN owner_user_id INTEGER", () => {});
    database.run(`CREATE TABLE IF NOT EXISTS parent_alert_state (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_phone TEXT NOT NULL, alert_type TEXT NOT NULL, alert_ref_id INTEGER NOT NULL, parent_user_id INTEGER, dismissed INTEGER DEFAULT 0, dismissed_progress INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(parent_phone, alert_type, alert_ref_id))`);
    database.run("ALTER TABLE parent_alert_state ADD COLUMN parent_user_id INTEGER", () => {});
    database.run("ALTER TABLE parent_alert_state ADD COLUMN dismissed_progress INTEGER DEFAULT 0", () => {});
    database.run(`CREATE TABLE IF NOT EXISTS consent_life (id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, content_hash TEXT NOT NULL UNIQUE, consent_json TEXT NOT NULL, created_at TEXT NOT NULL)`);
    database.run(`CREATE TABLE IF NOT EXISTS consent_record (id INTEGER PRIMARY KEY AUTOINCREMENT, user_phone TEXT NOT NULL, user_id INTEGER, role TEXT NOT NULL, consent_life_id INTEGER NOT NULL, accepted_at TEXT NOT NULL, recorded_at TEXT NOT NULL, UNIQUE(user_phone, consent_life_id), FOREIGN KEY(consent_life_id) REFERENCES consent_life(id))`);
    database.run("CREATE INDEX IF NOT EXISTS idx_consent_record_user_phone ON consent_record(user_phone, consent_life_id)");
    database.run(`CREATE TABLE IF NOT EXISTS user_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL UNIQUE, user_key TEXT NOT NULL, user_id INTEGER, role TEXT NOT NULL, logged_in_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER DEFAULT 0, end_reason TEXT)`);
    database.run("CREATE INDEX IF NOT EXISTS idx_user_sessions_user_key ON user_sessions(user_key, logged_in_at)");
    database.run(`CREATE TABLE IF NOT EXISTS revision_tracker (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, subject TEXT, level TEXT, progress INTEGER DEFAULT 0, status TEXT DEFAULT 'Pending', assigned INTEGER DEFAULT 0, timer_seconds INTEGER DEFAULT 0, max_time_minutes INTEGER DEFAULT 90, alert_dismissed INTEGER DEFAULT 0, alert_dismissed_progress INTEGER DEFAULT 0, is_custom INTEGER DEFAULT 0, user_key TEXT, owner_user_id INTEGER, UNIQUE(name, subject, user_key))`);
    database.run("ALTER TABLE revision_tracker ADD COLUMN owner_user_id INTEGER", () => {});
    database.run("ALTER TABLE revision_tracker ADD COLUMN level TEXT", () => {});
    database.run("ALTER TABLE revision_tracker ADD COLUMN alert_dismissed INTEGER DEFAULT 0", () => {});
    database.run("ALTER TABLE revision_tracker ADD COLUMN alert_dismissed_progress INTEGER DEFAULT 0", () => {});
    database.run("ALTER TABLE revision_tracker ADD COLUMN timer_seconds INTEGER DEFAULT 0", () => {});
    database.run("ALTER TABLE revision_tracker ADD COLUMN max_time_minutes INTEGER DEFAULT 90", () => {});
    database.run("ALTER TABLE revision_tracker ADD COLUMN is_custom INTEGER DEFAULT 0", () => {});
    database.run("UPDATE revision_tracker SET max_time_minutes = 90 WHERE max_time_minutes IS NULL OR max_time_minutes = 0", () => {});
    database.run("UPDATE users SET user_id = rowid WHERE user_id IS NULL", () => {});
    database.run("UPDATE subject_hub SET owner_user_id = (SELECT user_id FROM users WHERE users.phone = subject_hub.user_key) WHERE owner_user_id IS NULL", () => {});
    database.run("UPDATE exam_tracker SET owner_user_id = (SELECT user_id FROM users WHERE users.phone = exam_tracker.user_key) WHERE owner_user_id IS NULL", () => {});
    database.run("UPDATE mistakes_log SET owner_user_id = (SELECT user_id FROM users WHERE users.phone = mistakes_log.user_key) WHERE owner_user_id IS NULL", () => {});
    database.run("UPDATE uploaded_files SET owner_user_id = (SELECT user_id FROM users WHERE users.phone = uploaded_files.user_key) WHERE owner_user_id IS NULL", () => {});
    database.run("UPDATE teacher_feedback SET owner_user_id = (SELECT user_id FROM users WHERE users.phone = teacher_feedback.user_key) WHERE owner_user_id IS NULL", () => {});
    database.run("UPDATE revision_tracker SET owner_user_id = (SELECT user_id FROM users WHERE users.phone = revision_tracker.user_key) WHERE owner_user_id IS NULL", () => {});
    database.run("UPDATE consent_record SET user_id = (SELECT user_id FROM users WHERE users.phone = consent_record.user_phone) WHERE user_id IS NULL", () => {});
    database.run("UPDATE user_links SET parent_user_id = (SELECT user_id FROM users WHERE users.phone = user_links.parent_phone), student_user_id = (SELECT user_id FROM users WHERE users.phone = user_links.student_phone) WHERE parent_user_id IS NULL OR student_user_id IS NULL", () => {});
    database.run("UPDATE user_links SET user_key = 'family-' || student_user_id WHERE user_key IS NULL OR user_key = ''", () => {});
    database.run("UPDATE parent_alert_state SET parent_user_id = (SELECT user_id FROM users WHERE users.phone = parent_alert_state.parent_phone) WHERE parent_user_id IS NULL", () => {});
    database.run("CREATE TRIGGER IF NOT EXISTS set_user_id_after_insert AFTER INSERT ON users WHEN NEW.user_id IS NULL BEGIN UPDATE users SET user_id = NEW.rowid WHERE phone = NEW.phone; END");
    database.run("CREATE TRIGGER IF NOT EXISTS set_activity_owner_after_insert AFTER INSERT ON subject_hub WHEN NEW.owner_user_id IS NULL BEGIN UPDATE subject_hub SET owner_user_id = (SELECT user_id FROM users WHERE phone = NEW.user_key) WHERE id = NEW.id; END");
    database.run("CREATE TRIGGER IF NOT EXISTS set_exam_owner_after_insert AFTER INSERT ON exam_tracker WHEN NEW.owner_user_id IS NULL BEGIN UPDATE exam_tracker SET owner_user_id = (SELECT user_id FROM users WHERE phone = NEW.user_key) WHERE id = NEW.id; END");
    database.run("CREATE TRIGGER IF NOT EXISTS set_revision_owner_after_insert AFTER INSERT ON revision_tracker WHEN NEW.owner_user_id IS NULL BEGIN UPDATE revision_tracker SET owner_user_id = (SELECT user_id FROM users WHERE phone = NEW.user_key) WHERE id = NEW.id; END");
    database.run("CREATE TRIGGER IF NOT EXISTS set_link_ids_after_insert AFTER INSERT ON user_links BEGIN UPDATE user_links SET parent_user_id = (SELECT user_id FROM users WHERE phone = NEW.parent_phone), student_user_id = (SELECT user_id FROM users WHERE phone = NEW.student_phone), user_key = COALESCE(NEW.user_key, 'family-' || (SELECT user_id FROM users WHERE phone = NEW.student_phone)) WHERE id = NEW.id; END");
  });
};

if (db) {
  initializeDatabaseSchema(db);
}

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/admin/')) return next();
  const userPhone = String(req.body?.userKey || req.body?.userPhone || '').trim();
  if (!userPhone) return next();
  db.get('SELECT blocked FROM users WHERE phone = ?', [userPhone], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (Number(row?.blocked) === 1) return res.status(403).json({ error: 'This account has been blocked by the app owner.' });
    next();
  });
});

function calculateALGrade(score, totalScore) {
  if (score === null || score === undefined || !totalScore) return "Ungraded";
  const percentage = Math.round((score / totalScore) * 100);
  if (percentage >= 90) return "AL 1";
  if (percentage >= 85) return "AL 2";
  if (percentage >= 80) return "AL 3";
  if (percentage >= 75) return "AL 4";
  if (percentage >= 65) return "AL 5";
  if (percentage >= 45) return "AL 6";
  if (percentage >= 20) return "AL 7";
  return "AL 8";
}

// Seeds the baseline pre-populated examination list database matrix dynamically from master configuration mapping
const masterExamBank = [
  { name: "2026 Nanyang Prelim Math Paper 2", subject: "Mathematics" },
  { name: "2026 Raffles Girls Science Paper", subject: "Science" },
  { name: "2026 Rosyth English Comprehension OEQ", subject: "English" },
  { name: "2026 ACS Junior Math Booklet B", subject: "Mathematics" },
  { name: "2026 Tao Nan Science Section B Mock", subject: "Science" }
];

app.get('/api/syllabus', (req, res) => {
  const syllabusPath = path.join(__dirname, 'syllabus.json');
  fs.readFile(syllabusPath, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: "Failed to read internal syllabus.json template." });
    res.json(JSON.parse(data));
  });
});

const resolveUserRole = (existingRole, requestedRole) => {
  const normalizedRequested = String(requestedRole || 'student').trim().toLowerCase();
  const normalizedExisting = existingRole ? String(existingRole).trim().toLowerCase() : '';

  if (!normalizedExisting) return normalizedRequested;
  if (normalizedExisting === normalizedRequested) return normalizedExisting;
  if (normalizedExisting === 'parent' || normalizedRequested === 'parent') return 'parent';
  return 'student';
};

const ensureUserRole = (phone, requestedRole, callback) => {
  const cleanPhone = String(phone || '').trim();
  if (!cleanPhone) return callback(new Error('Phone number is required.'));

  db.get('SELECT role FROM users WHERE phone = ?', [cleanPhone], (err, row) => {
    if (err) return callback(err);
    const resolvedRole = resolveUserRole(row?.role, requestedRole);
    db.run('INSERT OR IGNORE INTO users (phone, created_at, role) VALUES (?, ?, ?)', [cleanPhone, new Date().toISOString(), resolvedRole], function(insertErr) {
      if (insertErr) return callback(insertErr);
      if (this.changes === 0) {
        db.run('UPDATE users SET role = ? WHERE phone = ?', [resolvedRole, cleanPhone], function(updateErr) {
          if (updateErr) return callback(updateErr);
          callback(null, resolvedRole);
        });
      } else {
        callback(null, resolvedRole);
      }
    });
  });
};

app.post('/api/auth/check', (req, res) => {
  const { userKey } = req.body;
  if (!userKey) return res.status(400).json({ error: "Mobile registration identifier missing." });
  const cleanPhone = userKey.trim();
  db.get("SELECT COUNT(*) as count, role, avatar FROM users WHERE phone = ?", [cleanPhone], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get('SELECT 1 FROM user_links WHERE parent_phone = ? LIMIT 1', [cleanPhone], (parentErr, parentLink) => {
      if (parentErr) return res.status(500).json({ error: parentErr.message });
      db.get('SELECT 1 FROM user_links WHERE student_phone = ? LIMIT 1', [cleanPhone], (studentErr, studentLink) => {
        if (studentErr) return res.status(500).json({ error: studentErr.message });
        const exists = Number(row?.count || 0) > 0;
        const role = parentLink ? 'parent' : (studentLink ? 'student' : (row?.role || null));
        res.json({ exists, role, avatar: row?.avatar || null });
      });
    });
  });
});

app.post('/api/profile/avatar', (req, res) => {
  const cleanPhone = String(req.body?.userKey || '').trim();
  const avatar = String(req.body?.avatar || '').trim();
  if (!cleanPhone || !avatar) return res.status(400).json({ error: 'User key and avatar are required.' });
  db.run('UPDATE users SET avatar = ? WHERE phone = ?', [avatar, cleanPhone], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'User not found.' });
    res.json({ success: true, avatar });
  });
});

app.post('/api/sessions/start', (req, res) => {
  const cleanPhone = String(req.body?.userKey || '').trim();
  const requestedRole = String(req.body?.role || '').trim().toLowerCase();
  if (!cleanPhone) return res.status(400).json({ error: 'User key is required.' });

  db.get('SELECT user_id, role FROM users WHERE phone = ?', [cleanPhone], (userError, user) => {
    if (userError) return res.status(500).json({ error: userError.message });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const role = ['parent', 'student'].includes(requestedRole) ? requestedRole : (user.role || 'student');
    const sessionId = crypto.randomUUID();
    const loggedInAt = new Date().toISOString();
    db.run(
      "UPDATE user_sessions SET ended_at = last_seen_at, duration_seconds = MAX(0, CAST((julianday(last_seen_at) - julianday(logged_in_at)) * 86400 AS INTEGER)), end_reason = 'replaced' WHERE user_key = ? AND ended_at IS NULL",
      [cleanPhone],
      function(closeError) {
        if (closeError) return res.status(500).json({ error: closeError.message });
        db.run(
          'INSERT INTO user_sessions (session_id, user_key, user_id, role, logged_in_at, last_seen_at, duration_seconds) VALUES (?, ?, ?, ?, ?, ?, 0)',
          [sessionId, cleanPhone, user.user_id || null, role, loggedInAt, loggedInAt],
          function(insertError) {
            if (insertError) return res.status(500).json({ error: insertError.message });
            res.json({ success: true, sessionId, loggedInAt });
          }
        );
      }
    );
  });
});

app.post('/api/sessions/heartbeat', (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  const cleanPhone = String(req.body?.userKey || '').trim();
  if (!sessionId || !cleanPhone) return res.status(400).json({ error: 'Session ID and user key are required.' });

  const lastSeenAt = new Date().toISOString();
  db.run(
    'UPDATE user_sessions SET last_seen_at = ?, duration_seconds = MAX(0, CAST((julianday(?) - julianday(logged_in_at)) * 86400 AS INTEGER)) WHERE session_id = ? AND user_key = ? AND ended_at IS NULL',
    [lastSeenAt, lastSeenAt, sessionId, cleanPhone],
    function(error) {
      if (error) return res.status(500).json({ error: error.message });
      if (this.changes === 0) return res.status(404).json({ error: 'Active session not found.' });
      res.json({ success: true, lastSeenAt });
    }
  );
});

app.post('/api/sessions/end', (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  const cleanPhone = String(req.body?.userKey || '').trim();
  const endReason = String(req.body?.reason || 'app_background').trim().slice(0, 50);
  if (!sessionId || !cleanPhone) return res.status(400).json({ error: 'Session ID and user key are required.' });

  db.get('SELECT logged_in_at, ended_at, duration_seconds FROM user_sessions WHERE session_id = ? AND user_key = ?', [sessionId, cleanPhone], (lookupError, session) => {
    if (lookupError) return res.status(500).json({ error: lookupError.message });
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    if (session.ended_at) return res.json({ success: true, durationSeconds: Number(session.duration_seconds) || 0 });

    const endedAt = new Date().toISOString();
    const durationSeconds = Math.max(0, Math.floor((Date.parse(endedAt) - Date.parse(session.logged_in_at)) / 1000));
    db.run(
      'UPDATE user_sessions SET last_seen_at = ?, ended_at = ?, duration_seconds = ?, end_reason = ? WHERE session_id = ? AND user_key = ? AND ended_at IS NULL',
      [endedAt, endedAt, durationSeconds, endReason || 'app_background', sessionId, cleanPhone],
      function(updateError) {
        if (updateError) return res.status(500).json({ error: updateError.message });
        res.json({ success: true, durationSeconds });
      }
    );
  });
});

const ensureConsentVersion = (disclaimer, callback) => {
  if (!disclaimer || !disclaimer.version) return callback(new Error('A versioned consent document is required.'));
  const consentJson = JSON.stringify(disclaimer);
  const contentHash = crypto.createHash('sha256').update(consentJson).digest('hex');
  const createdAt = new Date().toISOString();
  db.run(
    'INSERT OR IGNORE INTO consent_life (version, content_hash, consent_json, created_at) VALUES (?, ?, ?, ?)',
    [String(disclaimer.version), contentHash, consentJson, createdAt],
    function(insertError) {
      if (insertError) return callback(insertError);
      db.get('SELECT id, version, content_hash FROM consent_life WHERE content_hash = ?', [contentHash], callback);
    }
  );
};

app.post('/api/consent/status', (req, res) => {
  const cleanPhone = String(req.body?.userPhone || '').trim();
  const { disclaimer } = req.body || {};
  if (!cleanPhone || !disclaimer?.version) return res.status(400).json({ error: 'Valid user and consent document are required.' });

  ensureConsentVersion(disclaimer, (versionError, consentLife) => {
    if (versionError) return res.status(500).json({ error: versionError.message });
    db.get(
      'SELECT id, accepted_at FROM consent_record WHERE user_phone = ? AND consent_life_id = ?',
      [cleanPhone, consentLife.id],
      (recordError, record) => {
        if (recordError) return res.status(500).json({ error: recordError.message });
        res.json({ accepted: Boolean(record?.id), consentLifeId: consentLife.id, version: consentLife.version, acceptedAt: record?.accepted_at || null });
      }
    );
  });
});

app.post('/api/consent', (req, res) => {
  const { userPhone, role, disclaimer } = req.body;
  const cleanPhone = String(userPhone || '').trim();
  const cleanRole = String(role || '').trim().toLowerCase();
  if (!cleanPhone || !['parent', 'student'].includes(cleanRole) || !disclaimer || !disclaimer.version) {
    return res.status(400).json({ error: 'Valid user, role, and disclaimer are required.' });
  }

  ensureConsentVersion(disclaimer, (versionError, consentLife) => {
    if (versionError) return res.status(500).json({ error: versionError.message });
    const acceptedAt = new Date().toISOString();
    db.run(
      'INSERT OR IGNORE INTO consent_record (user_phone, user_id, role, consent_life_id, accepted_at, recorded_at) VALUES (?, (SELECT user_id FROM users WHERE phone = ?), ?, ?, ?, ?)',
      [cleanPhone, cleanPhone, cleanRole, consentLife.id, acceptedAt, acceptedAt],
      function(recordError) {
        if (recordError) return res.status(500).json({ error: recordError.message });
        const insertedId = this.lastID || null;
        db.get('SELECT id, accepted_at FROM consent_record WHERE user_phone = ? AND consent_life_id = ?', [cleanPhone, consentLife.id], (lookupError, record) => {
          if (lookupError) return res.status(500).json({ error: lookupError.message });
          res.json({ success: true, id: insertedId || record.id, consentLifeId: consentLife.id, disclaimerVersion: consentLife.version, disclaimerHash: consentLife.content_hash, acceptedAt: record.accepted_at });
        });
      }
    );
  });
});

// A student is unlocked only once their linked parent has accepted consent on their behalf.
const getChildUnlockStatus = (studentPhone, callback) => {
  db.get('SELECT parent_phone FROM user_links WHERE student_phone = ? LIMIT 1', [studentPhone], (linkError, link) => {
    if (linkError) return callback(linkError);
    if (!link || !link.parent_phone) return callback(null, { unlocked: false, linked: false, parentConsented: false, parentPhone: null });
    db.get('SELECT id FROM consent_record WHERE user_phone = ? LIMIT 1', [link.parent_phone], (consentError, record) => {
      if (consentError) return callback(consentError);
      const parentConsented = Boolean(record);
      callback(null, { unlocked: parentConsented, linked: true, parentConsented, parentPhone: link.parent_phone });
    });
  });
};

app.post('/api/consent/child-status', (req, res) => {
  const cleanPhone = String(req.body?.userPhone || '').trim();
  if (!cleanPhone) return res.status(400).json({ error: 'A valid student phone number is required.' });
  getChildUnlockStatus(cleanPhone, (error, status) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json(status);
  });
});

app.get('/api/admin/consents', (req, res) => {
  const suppliedToken = req.get('x-admin-token') || String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!config.adminToken || suppliedToken !== config.adminToken) return res.status(401).json({ error: 'Valid admin token is required.' });
  db.all('SELECT record.id, record.user_phone, record.role, life.id AS consent_life_id, life.version AS disclaimer_version, life.content_hash AS disclaimer_hash, life.created_at AS consent_created_at, record.accepted_at, record.recorded_at FROM consent_record record JOIN consent_life life ON life.id = record.consent_life_id ORDER BY record.recorded_at', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

const requireAdminMiddleware = (req, res, next) => {
  const suppliedToken = req.get('x-admin-token') || String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!config.adminToken || suppliedToken !== config.adminToken) return res.status(401).json({ error: 'Valid admin token is required.' });
  next();
};

app.get('/api/admin/users', requireAdminMiddleware, (req, res) => {
  db.all('SELECT user_id, phone, created_at, role, blocked FROM users ORDER BY created_at DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/admin/users/:phone/block', requireAdminMiddleware, (req, res) => {
  db.run('UPDATE users SET blocked = 1 WHERE phone = ?', [String(req.params.phone).trim()], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'User not found.' });
    res.json({ success: true, blocked: true });
  });
});

app.post('/api/admin/users/:phone/unblock', requireAdminMiddleware, (req, res) => {
  db.run('UPDATE users SET blocked = 0 WHERE phone = ?', [String(req.params.phone).trim()], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'User not found.' });
    res.json({ success: true, blocked: false });
  });
});

function requireAdminToken(req, res) {
  const suppliedToken = req.get('x-admin-token') || String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!config.adminToken || suppliedToken !== config.adminToken) {
    res.status(401).json({ error: 'Valid admin token is required.' });
    return false;
  }
  return true;
}

app.get('/api/admin/tables', (req, res) => {
  if (!requireAdminToken(req, res)) return;
  db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name", (err, tables) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json((tables || []).map(table => table.name));
  });
});

app.get('/api/admin/tables/:tableName', (req, res) => {
  if (!requireAdminToken(req, res)) return;
  const tableName = String(req.params.tableName || '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName) || tableName.startsWith('sqlite_')) {
    return res.status(400).json({ error: 'Invalid table name.' });
  }

  db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName], (lookupErr, table) => {
    if (lookupErr) return res.status(500).json({ error: lookupErr.message });
    if (!table) return res.status(404).json({ error: 'Table not found.' });
    db.all(`PRAGMA table_info("${tableName}")`, (columnErr, columns) => {
      if (columnErr) return res.status(500).json({ error: columnErr.message });
      db.all(`SELECT * FROM "${tableName}" LIMIT 5000`, (rowErr, rows) => {
        if (rowErr) return res.status(500).json({ error: rowErr.message });
        res.json({ table: tableName, columns: columns || [], rows: rows || [] });
      });
    });
  });
});

function getStudentDataKey(studentPhone, callback) {
  const cleanPhone = String(studentPhone || '').trim();
  db.get("SELECT COALESCE((SELECT user_key FROM user_links WHERE student_phone = ? AND user_key IS NOT NULL AND user_key <> '' LIMIT 1), (SELECT user_key FROM user_links WHERE parent_phone = ? AND user_key IS NOT NULL AND user_key <> '' LIMIT 1), phone) AS data_key FROM users WHERE phone = ?", [cleanPhone, cleanPhone, cleanPhone], (err, row) => {
    if (err) return callback(err);
    callback(null, row?.data_key || cleanPhone);
  });
}

function withStudentDataKey(studentPhone, operation) {
  getStudentDataKey(studentPhone, (err, dataKey) => {
    if (err) return operation(err);
    operation(null, dataKey);
  });
}

function seedStudentBanks(studentPhone, callback) {
  fs.readFile(path.join(__dirname, 'exams_bank.json'), 'utf8', (examError, examData) => {
    if (examError) return callback(examError);
    fs.readFile(path.join(__dirname, 'revision.json'), 'utf8', (revisionError, revisionData) => {
      if (revisionError) return callback(revisionError);

      let examBank;
      let revisionBank;
      try {
        examBank = JSON.parse(examData);
        revisionBank = JSON.parse(revisionData);
      } catch (parseError) {
        return callback(parseError);
      }

      getStudentDataKey(studentPhone, (keyError, dataKey) => {
        if (keyError) return callback(keyError);
        const seedExams = (index) => {
          if (index >= examBank.length) return seedRevisions(0);
          const exam = examBank[index];
          db.run("INSERT INTO exam_tracker (name, subject, score, total_score, status, assigned, timer_seconds, max_time_minutes, alert_dismissed, is_custom, user_key) SELECT ?, ?, 0, 100, 'Pending', 0, 0, 90, 0, 0, ? WHERE NOT EXISTS (SELECT 1 FROM exam_tracker WHERE name = ? AND subject = ? AND user_key = ?)", [exam.name, exam.subject, dataKey, exam.name, exam.subject, dataKey], seedError => {
            if (seedError) return callback(seedError);
            seedExams(index + 1);
          });
        };
        const seedRevisions = (index) => {
          if (index >= revisionBank.length) return callback(null);
          const topic = revisionBank[index];
          db.run("INSERT OR IGNORE INTO revision_tracker (name, subject, level, progress, status, assigned, timer_seconds, max_time_minutes, alert_dismissed, alert_dismissed_progress, is_custom, user_key) VALUES (?, ?, ?, 0, 'Pending', 0, 0, 90, 0, 0, 0, ?)", [topic.name, topic.subject, topic.level || '', dataKey], seedError => {
            if (seedError) return callback(seedError);
            seedRevisions(index + 1);
          });
        };
        seedExams(0);
      });
    });
  });
}

app.post('/api/auth/onboard', (req, res) => {
  const { userKey, selectedTopics, role, parentUserKey, studentUserKey, avatar } = req.body;
  if (!userKey || !selectedTopics) return res.status(400).json({ error: "Onboarding parameters incomplete." });

  const cleanPhone = userKey.trim();
  const requestedRole = String(role || 'student').trim().toLowerCase();
  const linkedParentPhone = parentUserKey ? String(parentUserKey).trim() : '';
  const linkedStudentPhone = studentUserKey ? String(studentUserKey).trim() : '';
  const cleanAvatar = typeof avatar === 'string' && avatar.trim() ? avatar.trim() : null;
  if (!['parent', 'student'].includes(requestedRole)) return res.status(400).json({ error: 'Role must be parent or student.' });
  if (requestedRole === 'parent' && !linkedStudentPhone) return res.status(400).json({ error: 'Student phone number is required for parent onboarding.' });
  if (requestedRole === 'parent' && linkedStudentPhone && linkedStudentPhone === cleanPhone) return res.status(400).json({ error: 'Parent and student numbers must be different.' });

  db.get("SELECT role FROM users WHERE phone = ?", [cleanPhone], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    const resolvedRole = resolveUserRole(row?.role, requestedRole);
    const createdAt = new Date().toISOString();

    db.serialize(() => {
      db.run("INSERT OR IGNORE INTO users (phone, created_at, role, avatar) VALUES (?, ?, ?, ?)", [cleanPhone, createdAt, resolvedRole, cleanAvatar], function(insertErr) {
        if (insertErr) return res.status(500).json({ error: insertErr.message });

        if (this.changes === 0) {
          db.run("UPDATE users SET role = ?, avatar = COALESCE(?, avatar) WHERE phone = ?", [resolvedRole, cleanAvatar, cleanPhone], function(updateErr) {
            if (updateErr) return res.status(500).json({ error: updateErr.message });
            continueOnboarding();
          });
        } else {
          continueOnboarding();
        }
      });

      const continueOnboarding = () => {
        if (requestedRole === 'parent' && linkedStudentPhone) {
          ensureUserRole(linkedStudentPhone, 'student', (studentErr) => {
            if (studentErr) return res.status(500).json({ error: studentErr.message });
            db.run("INSERT OR IGNORE INTO user_links (parent_phone, student_phone, user_key, created_at) VALUES (?, ?, 'family-' || (SELECT user_id FROM users WHERE phone = ?), ?)", [cleanPhone, linkedStudentPhone, linkedStudentPhone, createdAt], linkErr => {
              if (linkErr) return res.status(500).json({ error: linkErr.message });
              seedStudentBanks(linkedStudentPhone, seedError => {
                if (seedError) return res.status(500).json({ error: seedError.message });
                seedOnboarding();
              });
            });
          });
          return;
        }
        if (linkedParentPhone && requestedRole === 'student') {
          db.get('SELECT user_id FROM users WHERE phone = ?', [cleanPhone], (studentErr, studentRow) => {
            if (studentErr) return res.status(500).json({ error: studentErr.message });
            const linkUserKey = `family-${studentRow.user_id}`;
            db.run("INSERT OR IGNORE INTO user_links (parent_phone, student_phone, user_key, created_at) VALUES (?, ?, ?, ?)", [linkedParentPhone, cleanPhone, linkUserKey, createdAt], function(linkErr) {
              if (linkErr) return res.status(500).json({ error: linkErr.message });
              seedOnboarding();
            });
          });
        } else {
          seedOnboarding();
        }
      };

      const seedOnboarding = () => {
        const ownerPhone = requestedRole === 'parent' ? linkedStudentPhone : cleanPhone;
        getStudentDataKey(ownerPhone, (keyError, dataKey) => {
          if (keyError) return res.status(500).json({ error: keyError.message });
          const stmt = db.prepare("INSERT INTO subject_hub (name, subject, level, confidence, progress, alert_dismissed, user_key) VALUES (?, ?, ?, 'Low', 0, 0, ?)");
          selectedTopics.forEach(topic => stmt.run(topic.name, topic.subject, topic.level, dataKey));
          stmt.finalize(() => res.json({ success: true, role: resolvedRole }));
        });
      };
    });
  });
});

const PIN_MAX_ATTEMPTS = 3;
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 64).toString('hex');
const isValidPin = (pin) => /^\d{6}$/.test(String(pin || ''));

app.post('/api/auth/pin/setup', (req, res) => {
  const cleanPhone = String(req.body?.userKey || '').trim();
  const { pin, confirmPin } = req.body || {};
  if (!cleanPhone) return res.status(400).json({ error: 'User key is required.' });
  if (!isValidPin(pin) || !isValidPin(confirmPin)) return res.status(400).json({ error: 'PIN must be exactly 6 digits.' });
  if (String(pin) !== String(confirmPin)) return res.status(400).json({ error: 'PIN and confirmation PIN do not match.' });

  db.get('SELECT phone FROM users WHERE phone = ?', [cleanPhone], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'User not found.' });

    const salt = crypto.randomBytes(16).toString('hex');
    const pinHash = hashPin(pin, salt);
    db.run(
      'UPDATE users SET pin_hash = ?, pin_salt = ?, pin_failed_attempts = 0, pin_locked = 0 WHERE phone = ?',
      [pinHash, salt, cleanPhone],
      function(updateErr) {
        if (updateErr) return res.status(500).json({ error: updateErr.message });
        res.json({ success: true });
      }
    );
  });
});

app.post('/api/auth/pin/status', (req, res) => {
  const cleanPhone = String(req.body?.userKey || '').trim();
  if (!cleanPhone) return res.status(400).json({ error: 'User key is required.' });

  db.get('SELECT pin_hash, pin_locked FROM users WHERE phone = ?', [cleanPhone], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'User not found.' });
    res.json({ pinSet: Boolean(row.pin_hash), locked: Number(row.pin_locked) === 1 });
  });
});

app.post('/api/auth/pin/verify', (req, res) => {
  const cleanPhone = String(req.body?.userKey || '').trim();
  const { pin } = req.body || {};
  if (!cleanPhone || !isValidPin(pin)) return res.status(400).json({ error: 'A valid 6-digit PIN is required.' });

  db.get('SELECT pin_hash, pin_salt, pin_failed_attempts, pin_locked FROM users WHERE phone = ?', [cleanPhone], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'User not found.' });
    if (!row.pin_hash) return res.status(409).json({ error: 'PIN has not been set up for this account.' });
    if (Number(row.pin_locked) === 1) return res.status(423).json({ success: false, locked: true, error: 'Account is locked after too many incorrect attempts. Ask your linked parent/student to unlock it.' });

    const suppliedHash = hashPin(pin, row.pin_salt);
    const storedBuffer = Buffer.from(row.pin_hash, 'hex');
    const suppliedBuffer = Buffer.from(suppliedHash, 'hex');
    const matches = storedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(storedBuffer, suppliedBuffer);

    if (matches) {
      return db.run('UPDATE users SET pin_failed_attempts = 0 WHERE phone = ?', [cleanPhone], (resetErr) => {
        if (resetErr) return res.status(500).json({ error: resetErr.message });
        res.json({ success: true });
      });
    }

    const attempts = Number(row.pin_failed_attempts || 0) + 1;
    const locked = attempts >= PIN_MAX_ATTEMPTS;
    db.run('UPDATE users SET pin_failed_attempts = ?, pin_locked = ? WHERE phone = ?', [attempts, locked ? 1 : 0, cleanPhone], (updateErr) => {
      if (updateErr) return res.status(500).json({ error: updateErr.message });
      res.status(locked ? 423 : 401).json({ success: false, locked, attemptsRemaining: Math.max(0, PIN_MAX_ATTEMPTS - attempts) });
    });
  });
});

app.post('/api/auth/pin/unlock', (req, res) => {
  const requesterPhone = String(req.body?.requesterUserKey || '').trim();
  const targetPhone = String(req.body?.targetUserKey || '').trim();
  if (!requesterPhone || !targetPhone) return res.status(400).json({ error: 'Both requester and target user keys are required.' });

  db.get(
    'SELECT 1 FROM user_links WHERE (parent_phone = ? AND student_phone = ?) OR (parent_phone = ? AND student_phone = ?)',
    [requesterPhone, targetPhone, targetPhone, requesterPhone],
    (linkErr, link) => {
      if (linkErr) return res.status(500).json({ error: linkErr.message });
      if (!link) return res.status(403).json({ error: 'You are not linked to this account.' });

      db.run('UPDATE users SET pin_failed_attempts = 0, pin_locked = 0 WHERE phone = ?', [targetPhone], function(updateErr) {
        if (updateErr) return res.status(500).json({ error: updateErr.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Target user not found.' });
        res.json({ success: true });
      });
    }
  );
});

app.post('/api/links/create', (req, res) => {
  const { parentUserKey, studentUserKey } = req.body;
  if (!parentUserKey || !studentUserKey) return res.status(400).json({ error: 'Both parent and student phone numbers are required.' });

  const parentPhone = String(parentUserKey).trim();
  const studentPhone = String(studentUserKey).trim();
  const createdAt = new Date().toISOString();

  ensureUserRole(parentPhone, 'parent', (parentErr, resolvedParentRole) => {
    if (parentErr) return res.status(500).json({ error: parentErr.message });
    ensureUserRole(studentPhone, 'student', (studentErr, resolvedStudentRole) => {
      if (studentErr) return res.status(500).json({ error: studentErr.message });
      db.get('SELECT user_id FROM users WHERE phone = ?', [studentPhone], (identityErr, studentRow) => {
        if (identityErr) return res.status(500).json({ error: identityErr.message });
        const linkUserKey = `family-${studentRow.user_id}`;
        db.run('INSERT OR IGNORE INTO user_links (parent_phone, student_phone, user_key, created_at) VALUES (?, ?, ?, ?)', [parentPhone, studentPhone, linkUserKey, createdAt], function(linkErr) {
          if (linkErr) return res.status(500).json({ error: linkErr.message });
          seedStudentBanks(studentPhone, seedError => {
            if (seedError) return res.status(500).json({ error: seedError.message });
            db.all('SELECT id, parent_phone, student_phone, user_key, created_at FROM user_links WHERE student_phone = ? ORDER BY created_at DESC', [studentPhone], (lookupErr, rows) => {
              if (lookupErr) return res.status(500).json({ error: lookupErr.message });
              res.json({ success: true, parentRole: resolvedParentRole, studentRole: resolvedStudentRole, created: this.changes > 0, linkedParents: rows || [] });
            });
          });
        });
      });
    });
  });
});

app.post('/api/links/children', (req, res) => {
  const { userKey } = req.body;
  if (!userKey) return res.status(400).json({ error: 'Parent user key is required.' });

  const parentPhone = String(userKey).trim();
  db.all(
    'SELECT ul.id, ul.parent_phone, ul.student_phone, ul.user_key, ul.created_at, u.pin_locked AS locked FROM user_links ul LEFT JOIN users u ON u.phone = ul.student_phone WHERE ul.parent_phone = ? ORDER BY ul.created_at DESC',
    [parentPhone],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json((rows || []).map(row => ({ ...row, locked: Number(row.locked) === 1 })));
    }
  );
});

app.post('/api/links/parent', (req, res) => {
  const { userKey } = req.body;
  if (!userKey) return res.status(400).json({ error: 'Student user key is required.' });

  const studentPhone = String(userKey).trim();
  db.all(
    'SELECT ul.id, ul.parent_phone, ul.student_phone, ul.user_key, ul.created_at, u.pin_locked AS locked FROM user_links ul LEFT JOIN users u ON u.phone = ul.parent_phone WHERE ul.student_phone = ? ORDER BY ul.created_at DESC',
    [studentPhone],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json((rows || []).map(row => ({ ...row, locked: Number(row.locked) === 1 })));
    }
  );
});

app.post('/api/exams/add', (req, res) => {
  const { userKey, name, subject } = req.body;
  if (!userKey || !name || !subject) {
    return res.status(400).json({ error: 'Missing exam details.' });
  }

  const cleanName = String(name).trim();
  const cleanSubject = String(subject).trim();
  if (!cleanName || !cleanSubject) {
    return res.status(400).json({ error: 'Exam name and subject are required.' });
  }

  getStudentDataKey(userKey, (keyError, dataKey) => {
  if (keyError) return res.status(500).json({ error: keyError.message });
  db.run(
    "INSERT INTO exam_tracker (name, subject, score, total_score, status, assigned, timer_seconds, max_time_minutes, alert_dismissed, is_custom, user_key) VALUES (?, ?, 0, 100, 'Pending', 0, 0, 90, 0, 1, ?)",
    [cleanName, cleanSubject, dataKey],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID, name: cleanName, subject: cleanSubject });
    }
  );
  });
});

//  NEW ENDPOINT: Parent toggles assignment variable status to true, unlocking the milestone for the child
app.post('/api/exams/assign', (req, res) => {
  const { id, userKey } = req.body;
  if (!id || !userKey) return res.status(400).json({ error: 'Missing assignment parameters.' });

  db.get("SELECT assigned FROM exam_tracker WHERE id = ?", [Number(id)], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Exam item not found.' });
    if (Number(row.assigned) === 1) return res.status(409).json({ error: 'This exam item has already been assigned by another parent.' });

    db.run("UPDATE exam_tracker SET assigned = 1, status = 'In Progress' WHERE id = ? AND CAST(assigned AS INTEGER) = 0", [Number(id)], function(updateErr) {
      if (updateErr) return res.status(500).json({ error: updateErr.message });
      res.json({ success: true, updated: this.changes });
    });
  });
});

app.post('/api/revisions/add', (req, res) => {
  const { userKey, name, subject, level } = req.body;
  if (!userKey || !name || !subject) {
    return res.status(400).json({ error: 'Missing revision details.' });
  }

  const cleanName = String(name).trim();
  const cleanSubject = String(subject).trim();
  const requestedLevel = String(level || 'P6').trim().toUpperCase();
  const cleanLevel = config.revisionLevels.includes(requestedLevel) ? requestedLevel : 'P6';
  if (!cleanName || !cleanSubject) {
    return res.status(400).json({ error: 'Revision name and subject are required.' });
  }

  getStudentDataKey(userKey, (keyError, dataKey) => {
  if (keyError) return res.status(500).json({ error: keyError.message });
  db.run(
    "INSERT INTO revision_tracker (name, subject, level, progress, status, assigned, timer_seconds, max_time_minutes, alert_dismissed, alert_dismissed_progress, is_custom, user_key) VALUES (?, ?, ?, 0, 'Pending', 0, 0, 90, 0, 0, 1, ?)",
    [cleanName, cleanSubject, cleanLevel, dataKey],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID, name: cleanName, subject: cleanSubject, level: cleanLevel });
    }
  );
  });
});

app.post('/api/revisions/assign', (req, res) => {
  const { id, userKey } = req.body;
  if (!id || !userKey) return res.status(400).json({ error: 'Missing assignment parameters.' });

  db.get("SELECT assigned FROM revision_tracker WHERE id = ?", [Number(id)], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Revision topic not found.' });
    if (Number(row.assigned) === 1) return res.status(409).json({ error: 'This revision topic has already been assigned by another parent.' });

    db.run("UPDATE revision_tracker SET assigned = 1, status = 'In Progress' WHERE id = ? AND CAST(assigned AS INTEGER) = 0", [Number(id)], function(updateErr) {
      if (updateErr) return res.status(500).json({ error: updateErr.message });
      res.json({ success: true, updated: this.changes });
    });
  });
});

function upsertParentAlertState(parentPhone, alertType, alertRefId, dismissed, dismissedProgress = 0, callback) {
  if (typeof dismissedProgress === 'function') {
    callback = dismissedProgress;
    dismissedProgress = 0;
  }
  const cleanPhone = String(parentPhone || '').trim();
  const cleanType = String(alertType || '').trim();
  const cleanId = Number(alertRefId);

  if (!cleanPhone || !cleanType || Number.isNaN(cleanId)) {
    return callback ? callback(null, false) : undefined;
  }

  db.run(
    "INSERT INTO parent_alert_state (parent_phone, alert_type, alert_ref_id, dismissed, dismissed_progress) VALUES (?, ?, ?, ?, ?) ON CONFLICT(parent_phone, alert_type, alert_ref_id) DO UPDATE SET dismissed = excluded.dismissed, dismissed_progress = excluded.dismissed_progress",
    [cleanPhone, cleanType, cleanId, dismissed ? 1 : 0, Number(dismissedProgress) || 0],
    function(err) {
      if (callback) callback(err, this && this.changes ? this.changes : !!this);
    }
  );
}

function getDismissedParentAlertSet(parentPhone, callback) {
  const cleanPhone = String(parentPhone || '').trim();
  db.all("SELECT alert_type, alert_ref_id, dismissed_progress FROM parent_alert_state WHERE parent_phone = ? AND dismissed = 1", [cleanPhone], (err, rows) => {
    if (err) return callback(err, new Set());
    const dismissed = new Set();
    (rows || []).forEach(row => dismissed.add(`${row.alert_type}:${Number(row.alert_ref_id)}:${Number(row.dismissed_progress) || 0}`));
    callback(null, dismissed);
  });
}

function clearLinkedParentAlertDismissal(alertType, alertId, studentPhone, callback) {
  db.run(
    "DELETE FROM parent_alert_state WHERE alert_type = ? AND alert_ref_id = ? AND parent_phone IN (SELECT parent_phone FROM user_links WHERE student_phone = ?)",
    [alertType, Number(alertId), String(studentPhone || '').trim()],
    callback
  );
}

function dismissAlertForUserOrLinkedChildren(tableName, updateSql, userKey, id, callback) {
  const cleanPhone = String(userKey || '').trim();
  const alertTypeMap = {
    revision_tracker: 'revision',
    exam_tracker: 'exam',
    subject_hub: 'syllabus'
  };
  const alertType = alertTypeMap[tableName] || 'custom';

  db.get("SELECT role FROM users WHERE phone = ?", [cleanPhone], (roleErr, userRow) => {
    if (roleErr) return callback(roleErr);

    if (userRow && String(userRow.role || '').toLowerCase() === 'parent') {
      const progressColumn = ['revision_tracker', 'subject_hub'].includes(tableName) ? 'progress' : '0';
      return db.get(`SELECT ${progressColumn} AS progress FROM ${tableName} WHERE id = ?`, [Number(id)], (progressErr, progressRow) => {
        if (progressErr) return callback(progressErr);
        upsertParentAlertState(cleanPhone, alertType, id, true, Number(progressRow?.progress) || 0, callback);
      });
    }

    db.run(updateSql, [id, cleanPhone], function(err) {
      if (err) return callback(err);
      if (this.changes > 0) return callback(null, this.changes);

      db.all('SELECT student_phone FROM user_links WHERE parent_phone = ?', [cleanPhone], (linkErr, linkRows) => {
        if (linkErr) return callback(linkErr);
        const linkedStudents = [...new Set((linkRows || []).map(row => row.student_phone).filter(Boolean))];
        if (linkedStudents.length === 0) return callback(null, 0);

        let index = 0;
        const tryNextStudent = () => {
          if (index >= linkedStudents.length) return callback(null, 0);
          const linkedStudent = linkedStudents[index++];

          db.run(updateSql, [id, linkedStudent], function(studentErr) {
            if (studentErr) return callback(studentErr);
            if (this.changes > 0) return callback(null, this.changes);
            tryNextStudent();
          });
        };

        tryNextStudent();
      });
    });
  });
}

function dismissAllAlertsForUser(userKey, callback) {
  const cleanPhone = String(userKey || '').trim();

  db.get("SELECT role FROM users WHERE phone = ?", [cleanPhone], (roleErr, userRow) => {
    if (roleErr) return callback(roleErr);

    if (userRow && String(userRow.role || '').toLowerCase() === 'parent') {
      db.all('SELECT student_phone FROM user_links WHERE parent_phone = ?', [cleanPhone], (linkErr, linkRows) => {
        if (linkErr) return callback(linkErr);
        const linkedStudents = [...new Set((linkRows || []).map(row => row.student_phone).filter(Boolean))];
        const phones = [cleanPhone, ...linkedStudents];
        const placeholders = phones.map(() => '?').join(', ');

        if (phones.length === 0) return callback(null, true);

        const linkedKeySubquery = "SELECT user_key FROM user_links WHERE parent_phone = ? OR student_phone IN (" + linkedStudents.map(() => '?').join(', ') + ")";
        const linkedKeyParams = [cleanPhone, ...linkedStudents];
        const queries = [
          ['exam', "SELECT id FROM exam_tracker WHERE user_key IN (" + placeholders + ") OR user_key IN (" + linkedKeySubquery + ")", [...phones, ...linkedKeyParams]],
          ['syllabus', "SELECT id, progress FROM subject_hub WHERE user_key IN (" + placeholders + ") OR user_key IN (" + linkedKeySubquery + ")", [...phones, ...linkedKeyParams]],
          ['revision', "SELECT id, progress FROM revision_tracker WHERE user_key IN (" + placeholders + ") OR user_key IN (" + linkedKeySubquery + ")", [...phones, ...linkedKeyParams]]
        ];

        let pending = queries.length;
        let finished = false;
        const finalize = (err) => {
          if (finished) return;
          if (err) {
            finished = true;
            return callback(err);
          }
          pending -= 1;
          if (pending === 0) {
            finished = true;
            callback(null, true);
          }
        };

        queries.forEach(([alertType, sql, params]) => {
          db.all(sql, params, (rowErr, rows) => {
            if (rowErr) return finalize(rowErr);
            const relevantRows = rows || [];
            if (relevantRows.length === 0) return finalize();

            let itemPending = relevantRows.length;
            if (itemPending === 0) return finalize();

            relevantRows.forEach(row => {
              upsertParentAlertState(cleanPhone, alertType, row.id, true, Number(row.progress) || 0, (stateErr) => {
                if (stateErr) return finalize(stateErr);
                itemPending -= 1;
                if (itemPending === 0) finalize();
              });
            });
          });
        });
      });
      return;
    }

    db.all('SELECT student_phone FROM user_links WHERE parent_phone = ?', [cleanPhone], (linkErr, linkRows) => {
      if (linkErr) return callback(linkErr);
      const linkedStudents = [...new Set((linkRows || []).map(row => row.student_phone).filter(Boolean))];
      const phones = [cleanPhone, ...linkedStudents];

      if (phones.length === 0) return callback(null, true);

      let pending = 0;
      let finished = false;
      const finish = (err) => {
        if (finished) return;
        if (err) {
          finished = true;
          return callback(err);
        }
        pending -= 1;
        if (pending === 0) {
          finished = true;
          callback(null, true);
        }
      };

      phones.forEach(phone => {
        pending += 3;
        db.run("UPDATE exam_tracker SET alert_dismissed = 1 WHERE user_key = ?", [phone], function(err) {
          if (err) return finish(err);
          finish();
        });
        db.run("UPDATE subject_hub SET alert_dismissed = 1 WHERE user_key = ?", [phone], function(err) {
          if (err) return finish(err);
          finish();
        });
        db.run("UPDATE revision_tracker SET alert_dismissed = 1, alert_dismissed_progress = progress WHERE user_key = ?", [phone], function(err) {
          if (err) return finish(err);
          finish();
        });
      });
    });
  });
}

app.post('/api/revisions/dismiss-alert', (req, res) => {
  const { id, userKey } = req.body;
  dismissAlertForUserOrLinkedChildren('revision_tracker', "UPDATE revision_tracker SET alert_dismissed = 1, alert_dismissed_progress = progress WHERE id = ? AND user_key = ?", userKey, id, function(err, updated) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, updated });
  });
});

app.post('/api/revisions/update-progress', (req, res) => {
  const { id, progress, elapsedSeconds, userKey } = req.body;
  if (!id || !userKey || ![0, 25, 50, 75, 100].includes(Number(progress))) return res.status(400).json({ error: 'Invalid revision progress parameters.' });
  const nextProgress = Number(progress);
  const nextStatus = nextProgress === 100 ? 'Completed' : 'In Progress';
  withStudentDataKey(userKey, (keyError, dataKey) => {
  if (keyError) return res.status(500).json({ error: keyError.message });
  const saveProgress = () => db.run("UPDATE revision_tracker SET progress = ?, status = ?, timer_seconds = ? WHERE id = ? AND user_key IN (?, ?) AND CAST(assigned AS INTEGER) = 1", [nextProgress, nextStatus, Math.max(0, Number(elapsedSeconds) || 0), Number(id), dataKey, userKey.trim()], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, updated: this.changes });
  });
  if (nextProgress === 100 && requireEvidenceLinking) {
    return db.get("SELECT COUNT(*) AS count FROM mistakes_log WHERE revision_id = ? AND user_key IN (?, ?)", [Number(id), dataKey, userKey.trim()], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row || row.count < 1) return res.status(409).json({ error: 'Add at least one linked Mistakes Log entry before marking this revision 100% complete.' });
      saveProgress();
    });
  }
  saveProgress();
  });
});

app.post('/api/revisions/update-timer', (req, res) => {
  const { id, elapsedSeconds, userKey } = req.body;
  if (!id || !userKey) return res.status(400).json({ error: 'Missing revision timer parameters.' });
  withStudentDataKey(userKey, (keyError, dataKey) => {
  if (keyError) return res.status(500).json({ error: keyError.message });
  db.run("UPDATE revision_tracker SET timer_seconds = ? WHERE id = ? AND user_key = ? AND CAST(assigned AS INTEGER) = 1", [Math.max(0, Number(elapsedSeconds) || 0), Number(id), dataKey], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, updated: this.changes });
  });
  });
});

//  NEW ENDPOINT: Parent clears finished test warnings from landing cockpit permanently
app.post('/api/exams/dismiss-alert', (req, res) => {
  const { id, userKey } = req.body;
  dismissAlertForUserOrLinkedChildren('exam_tracker', "UPDATE exam_tracker SET alert_dismissed = 1 WHERE id = ? AND user_key = ?", userKey, id, function(err, updated) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, updated });
  });
});

app.post('/api/syllabus/dismiss-alert', (req, res) => {
  const { id, userKey } = req.body;
  dismissAlertForUserOrLinkedChildren('subject_hub', "UPDATE subject_hub SET alert_dismissed = 1 WHERE id = ? AND user_key = ?", userKey, id, function(err, updated) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, updated });
  });
});

app.post('/api/alerts/dismiss-all', (req, res) => {
  const { userKey } = req.body;
  if (!userKey) return res.status(400).json({ error: 'Missing user key.' });
  dismissAllAlertsForUser(userKey, function(err, success) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: success === true });
  });
});

app.post('/api/exams/update', (req, res) => {
  const { examId, score, totalScore, status, elapsedSeconds, userKey } = req.body;
  const normalizedStatus = String(status || '').trim();
  if (normalizedStatus === 'Completed' && requireEvidenceLinking) {
    return withStudentDataKey(userKey, (keyError, dataKey) => {
      if (keyError) return res.status(500).json({ error: keyError.message });
      return db.get("SELECT COUNT(*) AS count FROM mistakes_log WHERE exam_id = ? AND user_key IN (?, ?)", [Number(examId), dataKey, userKey.trim()], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row || row.count < 1) return res.status(409).json({ error: 'Add at least one linked Mistakes Log entry before completing this exam paper.' });
        updateExamResult(dataKey);
      });
    });
  }
  withStudentDataKey(userKey, (keyError, dataKey) => {
  if (keyError) return res.status(500).json({ error: keyError.message });
  updateExamResult(dataKey);
  });
  function updateExamResult(dataKey) {
  db.run("UPDATE exam_tracker SET score = ?, total_score = ?, status = ?, timer_seconds = ?, alert_dismissed = 0 WHERE id = ? AND user_key = ?", [score, totalScore, normalizedStatus, Math.max(0, Number(elapsedSeconds) || 0), Number(examId), dataKey], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (normalizedStatus === 'Completed') {
      return clearLinkedParentAlertDismissal('exam', examId, userKey, clearError => {
        if (clearError) return res.status(500).json({ error: clearError.message });
        res.json({ success: true });
      });
    }
    res.json({ success: true });
  });
  }
});

app.post('/api/exams/update-timer', (req, res) => {
  const { id, elapsedSeconds, userKey } = req.body;
  if (!id || !userKey) return res.status(400).json({ error: 'Missing exam timer parameters.' });
  withStudentDataKey(userKey, (keyError, dataKey) => {
  if (keyError) return res.status(500).json({ error: keyError.message });
  db.run("UPDATE exam_tracker SET timer_seconds = ? WHERE id = ? AND user_key = ? AND CAST(assigned AS INTEGER) = 1", [Math.max(0, Number(elapsedSeconds) || 0), Number(id), dataKey], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, updated: this.changes });
  });
  });
});

app.post('/api/feedback/save', (req, res) => {
  const { source, month, subject, remarks, score, userKey } = req.body;
  db.run("INSERT INTO teacher_feedback (source, month, subject, remarks, score, user_key) VALUES (?, ?, ?, ?, ?, ?)", [source, month, subject, remarks.trim(), parseInt(score), userKey.trim()], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.post('/api/syllabus/update-progress', (req, res) => {
  const { id, progress, confidence, userKey } = req.body;
  if (!id || !userKey) return res.status(400).json({ error: 'Missing syllabus update parameters.' });
  if (confidence !== undefined && !config.confidenceLevels.includes(String(confidence))) {
    return res.status(400).json({ error: 'Invalid confidence level.' });
  }

  withStudentDataKey(userKey, (keyError, dataKey) => {
    if (keyError) return res.status(500).json({ error: keyError.message });
    const resolvedParams = confidence === undefined
      ? [Number(progress), Number(id), dataKey, userKey.trim()]
      : [Number(progress), String(confidence), Number(id), dataKey, userKey.trim()];
    const updateSql = confidence === undefined
      ? "UPDATE subject_hub SET progress = ?, alert_dismissed = 0 WHERE id = ? AND user_key IN (?, ?)"
      : "UPDATE subject_hub SET progress = ?, confidence = ?, alert_dismissed = 0 WHERE id = ? AND user_key IN (?, ?)";
    db.run(updateSql, resolvedParams, function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, updated: this.changes });
    });
  });
});

app.post('/api/errors/log-text', (req, res) => {
  const { userKey, title, category, description, hubId, revisionId, examId } = req.body;
  if (!userKey || (!title && !description)) return res.status(400).json({ error: 'Missing error log fields.' });
  
  if (requireEvidenceLinking && !revisionId && !examId) {
    return res.status(400).json({ error: 'Missing Link: You must link this mistake to an active revision or exam paper.' });
  }

  const recordTitle = (title || description || 'Student error').trim();
  const cleanCategory = category || 'General';
  const recordDetail = description ? description.trim() : recordTitle;

  db.run("INSERT INTO mistakes_log (name, description, category, photo_url, status, revision_id, exam_id, user_key) VALUES (?, ?, ?, NULL, '🔴 Unreviewed', ?, ?, ?)", 
    [recordTitle, recordDetail, cleanCategory, revisionId || null, examId || null, userKey.trim()], 
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, localId: this.lastID });
    }
  );
});

function getRevisionTopics(userKey, callback) {
  withStudentDataKey(userKey, (keyError, dataKey) => {
    if (keyError) return callback(keyError, []);
    db.all("SELECT id, name, subject, level, progress, status, assigned, timer_seconds, max_time_minutes, alert_dismissed, alert_dismissed_progress, is_custom, user_key FROM revision_tracker WHERE user_key IN (?, ?) ORDER BY id", [dataKey, String(userKey).trim()], callback);
  });
}

function getExamRows(userKey, callback) {
  withStudentDataKey(userKey, (keyError, dataKey) => {
    if (keyError) return callback(keyError, []);
    db.all("SELECT * FROM exam_tracker WHERE user_key IN (?, ?) ORDER BY id", [dataKey, String(userKey).trim()], callback);
  });
}

app.post('/api/dashboard', (req, res) => {
  const { userKey, profileType } = req.body;
  if (!userKey) return res.status(400).json({ error: "Missing userKey parameters token." });
  const cleanPhone = userKey.trim();

  const buildDashboardForUser = (targetPhone, targetedProfileType, isParentDashboard = false) => {
    withStudentDataKey(targetPhone, (keyError, dataKey) => {
      if (keyError) return res.status(500).json({ error: keyError.message });
    getExamRows(targetPhone, (err, examRows) => {
      const rawExams = examRows || [];
      const exams = rawExams.map(row => ({ id: row.id, title: row.name, subject: row.subject, score: row.score, totalScore: row.total_score, timer_seconds: row.timer_seconds, maxTimeMinutes: row.max_time_minutes || 90, alGrade: calculateALGrade(row.score, row.total_score), status: row.status, assigned: row.assigned, alert_dismissed: row.alert_dismissed, user_key: row.user_key }));

      db.all("SELECT * FROM teacher_feedback WHERE user_key = ?", [dataKey], (feedbackErr, feedbackRows) => {
        const feedback = feedbackRows || [];

        db.all("SELECT * FROM subject_hub WHERE user_key IN (?, ?)", [dataKey, targetPhone], (hubErr, hubRows) => {
          const syllabusProgress = hubRows || [];
          getRevisionTopics(targetPhone, (revisionError, revisionRows) => {
            if (revisionError) return res.status(500).json({ error: revisionError.message });
            const revisionTopics = revisionRows || [];

            const alerts = [];
            syllabusProgress.forEach(p => {
              if (isParentDashboard && [25, 50, 75, 100].includes(Number(p.progress)) && Number(p.alert_dismissed) === 0) {
                alerts.push({ id: p.id, type: 'syllabus', progress: Number(p.progress), message: `🎉 Syllabus milestone: Your child reached ${p.progress}% in "${p.name}" (${p.subject}) with confidence: ${p.confidence || 'Low'}.` });
              }
            });

            revisionTopics.forEach(topic => {
              const progress = Number(topic.progress);
              const dismissedProgress = Number(topic.alert_dismissed_progress) || 0;
              if (isParentDashboard && Number(topic.assigned) === 1 && progress > 0 && progress > dismissedProgress) {
                alerts.push({ id: topic.id, type: 'revision', progress, message: `🔁 Revision Update: ${isParentDashboard ? 'Your child' : 'You'} completed ${progress}% of "${topic.name}" (${topic.subject}).` });
              }
            });

            exams.forEach(e => {
              if (isParentDashboard && String(e.status || '').trim() === 'Completed' && Number(e.alert_dismissed) === 0) {
                alerts.push({ id: e.id, type: 'exam', message: `🏆 Milestone Reached: ${isParentDashboard ? 'Your child' : 'You'} has finished and synced "${e.title}" Scoring: ${e.score}/${e.totalScore} (${e.alGrade})!` });
              }
            });

            const finalizeParentResponse = (payload) => {
              if (!isParentDashboard) return res.json(payload);
              getDismissedParentAlertSet(targetPhone, (dismissErr, dismissedSet) => {
                if (dismissErr) return res.status(500).json({ error: dismissErr.message });
                payload.alerts = (payload.alerts || []).filter(alert => ![...dismissedSet].some(key => {
                  const [type, id, progress] = key.split(':');
                  return type === alert.type && Number(id) === Number(alert.id) && (type === 'revision' || type === 'syllabus' ? Number(alert.progress || 0) <= Number(progress || 0) : true);
                }));
                res.json(payload);
              });
            };

            if (targetedProfileType === 'student') {
              const studentRevisionTopics = revisionTopics.filter(topic => Number(topic.assigned) === 1 && String(topic.status || '').trim() !== 'Completed');
              db.all("SELECT name FROM mistakes_log WHERE user_key IN (?, ?) GROUP BY name ORDER BY MAX(id) DESC LIMIT 10", [dataKey, targetPhone], (err, distinctNames) => {
                const pastDescriptions = distinctNames ? distinctNames.map(r => r.name) : [];
                return finalizeParentResponse({ profileType: targetedProfileType, exams: exams.filter(e => e.assigned === 1 && e.status !== 'Completed'), pastDescriptions, feedback, syllabusProgress, revisionTopics: studentRevisionTopics, alerts });
              });
              return;
            }

            db.all("SELECT * FROM mistakes_log WHERE user_key IN (?, ?)", [dataKey, targetPhone], (err, mistakeRows) => {
              const aggregatedMistakesMap = {};
              const mistakeIds = (mistakeRows || []).map(row => row.id);
              const placeholders = mistakeIds.map(() => '?').join(', ');
              const filesQuery = mistakeIds.length > 0
                ? `SELECT mistake_id, relative_path FROM uploaded_files WHERE parent_phone_hash = ? AND mistake_id IN (${placeholders}) ORDER BY uploaded_at`
                : null;
              const fileParams = mistakeIds.length > 0
                ? [crypto.createHash('sha256').update(targetPhone).digest('hex'), ...mistakeIds]
                : [];
              const buildMistakes = (uploadedRows) => {
                const photosByMistake = {};
                (uploadedRows || []).forEach(file => {
                  if (!photosByMistake[file.mistake_id]) photosByMistake[file.mistake_id] = [];
                  const requestBaseUrl = `${req.protocol}://${req.get('host')}`;
                  photosByMistake[file.mistake_id].push(mediaStorage.getPublicUrl(file.relative_path, requestBaseUrl));
                });
                (mistakeRows || []).forEach(row => {
                  const cleanName = row.name.trim();
                  if (!aggregatedMistakesMap[cleanName]) aggregatedMistakesMap[cleanName] = { title: cleanName, category: row.category, occurrence: 0, descriptions: [], photos: [], photoDescriptions: [] };
                  aggregatedMistakesMap[cleanName].occurrence += 1;
                  if (row.description) aggregatedMistakesMap[cleanName].descriptions.push(row.description);
                  if (photosByMistake[row.id]) aggregatedMistakesMap[cleanName].photos.push(...photosByMistake[row.id]);
                  if (photosByMistake[row.id]) {
                    photosByMistake[row.id].forEach(() => aggregatedMistakesMap[cleanName].photoDescriptions.push(row.description || 'No description provided'));
                  } else if (row.photo_url) {
                    aggregatedMistakesMap[cleanName].photos.push(row.photo_url);
                    aggregatedMistakesMap[cleanName].photoDescriptions.push(row.description || 'No description provided');
                  }
                });
                finalizeParentResponse({ profileType: targetedProfileType, exams, mistakes: Object.values(aggregatedMistakesMap), alerts, feedback, syllabusProgress, revisionTopics });
              };
              if (!filesQuery) return buildMistakes([]);
              db.all(filesQuery, fileParams, (fileError, uploadedRows) => buildMistakes(fileError ? [] : uploadedRows));
            });
          });
        });
      });
    });
    });
  };

  if (profileType === 'student') {
    return buildDashboardForUser(cleanPhone, 'student', false);
  }

  db.all('SELECT student_phone FROM user_links WHERE parent_phone = ? ORDER BY created_at DESC', [cleanPhone], (linkErr, linkRows) => {
    if (linkErr) return res.status(500).json({ error: linkErr.message });

    const linkedStudents = (linkRows || []).map(row => row.student_phone).filter(Boolean);
    const parentExams = [];
    const parentSyllabus = [];
    const parentRevision = [];
    const parentFeedback = [];
    const parentAlerts = [];
    const parentMistakes = [];
    const childPhones = [...new Set(linkedStudents)];

    if (childPhones.length === 0) {
      return buildDashboardForUser(cleanPhone, 'parent', true);
    }

    const next = () => {
      const mergedExamMap = new Map();
      const mergedSyllabusMap = new Map();
      const mergedRevisionMap = new Map();
      const mergedAlertMap = new Map();

      [...parentExams, ...childPhones.flatMap(phone => ([]))].forEach(() => {});

      const sourceSets = [];
      sourceSets.push({ type: 'self', exams: parentExams, syllabus: parentSyllabus, revision: parentRevision, feedback: parentFeedback, alerts: parentAlerts, mistakes: parentMistakes });

      const allAlerts = [...parentAlerts];
      const aggregatedMistakes = new Map();
      parentMistakes.forEach(row => {
        const cleanName = String(row.name || 'Student error').trim();
        if (!aggregatedMistakes.has(cleanName)) {
          aggregatedMistakes.set(cleanName, {
            title: cleanName,
            category: row.category,
            occurrence: 0,
            descriptions: [],
            photos: [],
            photoDescriptions: []
          });
        }
        const mistake = aggregatedMistakes.get(cleanName);
        mistake.occurrence += 1;
        if (row.description) mistake.descriptions.push(row.description);
        if (row.photo_url) {
          mistake.photos.push(row.photo_url);
          mistake.photoDescriptions.push(row.description || 'No description provided');
        }
      });
      const allMistakes = [...aggregatedMistakes.values()];
      const allExams = [...parentExams];
      const allSyllabus = [...parentSyllabus];
      const allRevision = [...parentRevision];
      const allFeedback = [...parentFeedback];

      const mergedAlerts = new Map();
      const mergedExams = new Map();
      const mergedSyllabus = new Map();
      const mergedRevision = new Map();

      const pushUnique = (map, key, value) => {
        if (!map.has(key)) map.set(key, value);
      };

      allAlerts.forEach(alert => pushUnique(mergedAlerts, `${alert.type}:${alert.id}`, alert));
      allExams.forEach(exam => pushUnique(mergedExams, `exam:${exam.id}:${exam.user_key || 'self'}`, exam));
      allSyllabus.forEach(topic => pushUnique(mergedSyllabus, `syllabus:${topic.id}:${topic.user_key || 'self'}`, topic));
      allRevision.forEach(topic => pushUnique(mergedRevision, `revision:${topic.id}:${topic.user_key || 'self'}`, topic));

      const finalAlerts = [...mergedAlerts.values()];
      const finalExams = [...mergedExams.values()];
      const finalSyllabus = [...mergedSyllabus.values()];
      const finalRevision = [...mergedRevision.values()];

      getDismissedParentAlertSet(cleanPhone, (dismissErr, dismissedSet) => {
        if (dismissErr) return res.status(500).json({ error: dismissErr.message });

        const filteredAlerts = finalAlerts.filter(alert => ![...dismissedSet].some(key => {
          const [type, id, progress] = key.split(':');
          return type === alert.type && Number(id) === Number(alert.id) && (type === 'revision' || type === 'syllabus' ? Number(alert.progress || 0) <= Number(progress || 0) : true);
        }));
        return res.json({
          profileType: 'parent',
          exams: finalExams,
          mistakes: allMistakes,
          alerts: filteredAlerts,
          feedback: allFeedback,
          syllabusProgress: finalSyllabus,
          revisionTopics: finalRevision
        });
      });
    };

    const queue = [...childPhones];
    let completed = 0;

    const collectChildData = () => {
      if (completed >= queue.length) {
        return next();
      }

      const childPhone = queue[completed];
      completed += 1;

      withStudentDataKey(childPhone, (keyError, dataKey) => {
        if (keyError) return collectChildData();
      getExamRows(childPhone, (examErr, childExams) => {
        if (!examErr) parentExams.push(...(childExams || []).map(row => ({ ...row, user_key: childPhone })));

        db.all('SELECT * FROM subject_hub WHERE user_key IN (?, ?)', [dataKey, childPhone], (hubErr, childSyllabus) => {
          if (!hubErr) parentSyllabus.push(...(childSyllabus || []).map(row => ({ ...row, user_key: childPhone })));

          getRevisionTopics(childPhone, (revisionErr, childRevision) => {
            if (!revisionErr) parentRevision.push(...(childRevision || []).map(row => ({ ...row, user_key: childPhone })));

            db.all('SELECT * FROM teacher_feedback WHERE user_key IN (?, ?)', [dataKey, childPhone], (feedErr, childFeedback) => {
              if (!feedErr) parentFeedback.push(...(childFeedback || []).map(row => ({ ...row, user_key: childPhone })));

              db.all('SELECT * FROM mistakes_log WHERE user_key IN (?, ?)', [dataKey, childPhone], (mistakeErr, childMistakes) => {
                if (!mistakeErr) parentMistakes.push(...(childMistakes || []).map(row => ({ ...row, user_key: childPhone })));

                const childAlerts = [];
                (childSyllabus || []).forEach(p => {
                  if ([25, 50, 75, 100].includes(Number(p.progress)) && Number(p.alert_dismissed) === 0) {
                    childAlerts.push({ id: p.id, type: 'syllabus', progress: Number(p.progress), message: `🎉 Syllabus milestone: Child topic "${p.name}" in ${p.subject} reached ${p.progress}% with confidence: ${p.confidence || 'Low'}.` });
                  }
                });

                (childRevision || []).forEach(topic => {
                  const progress = Number(topic.progress);
                  const dismissedProgress = Number(topic.alert_dismissed_progress) || 0;
                  if (Number(topic.assigned) === 1 && progress > 0 && progress > dismissedProgress) {
                    childAlerts.push({ id: topic.id, type: 'revision', progress, message: `🔁 Revision Update: Child revision "${topic.name}" in ${topic.subject} reached ${progress}% completion.` });
                  }
                });

                (childExams || []).forEach(e => {
                  if (String(e.status || '').trim() === 'Completed' && Number(e.alert_dismissed) === 0) {
                    childAlerts.push({ id: e.id, type: 'exam', message: `🏆 Milestone Reached: Child prelim "${e.name}" scored ${e.score}/${e.total_score} (${calculateALGrade(e.score, e.total_score)})!` });
                  }
                });

                parentAlerts.push(...childAlerts);
                collectChildData();
              });
            });
          });
        });
      });
      });
    };

    getExamRows(cleanPhone, (selfExamErr, selfExams) => {
      if (!selfExamErr) parentExams.push(...(selfExams || []).map(row => ({ ...row, user_key: cleanPhone })));
      db.all('SELECT * FROM subject_hub WHERE user_key = ?', [cleanPhone], (selfHubErr, selfSyllabus) => {
        if (!selfHubErr) parentSyllabus.push(...(selfSyllabus || []).map(row => ({ ...row, user_key: cleanPhone })));
        getRevisionTopics(cleanPhone, (selfRevisionErr, selfRevision) => {
          if (!selfRevisionErr) parentRevision.push(...(selfRevision || []).map(row => ({ ...row, user_key: cleanPhone })));
          db.all('SELECT * FROM teacher_feedback WHERE user_key = ?', [cleanPhone], (selfFeedbackErr, selfFeedback) => {
            if (!selfFeedbackErr) parentFeedback.push(...(selfFeedback || []).map(row => ({ ...row, user_key: cleanPhone })));
            db.all('SELECT * FROM mistakes_log WHERE user_key = ?', [cleanPhone], (selfMistakeErr, selfMistakes) => {
              if (!selfMistakeErr) parentMistakes.push(...(selfMistakes || []).map(row => ({ ...row, user_key: cleanPhone })));

              (selfSyllabus || []).forEach(p => {
                if ([25, 50, 75, 100].includes(Number(p.progress)) && p.alert_dismissed === 0) {
                  parentAlerts.push({ id: p.id, type: 'syllabus', progress: Number(p.progress), message: `🎉 Syllabus milestone: Child topic "${p.name}" in ${p.subject} reached ${p.progress}% with confidence: ${p.confidence || 'Low'}.` });
                }
              });

              (selfRevision || []).forEach(topic => {
                const progress = Number(topic.progress);
                const dismissedProgress = Number(topic.alert_dismissed_progress) || 0;
                if (Number(topic.assigned) === 1 && progress > 0 && progress > dismissedProgress) {
                  parentAlerts.push({ id: topic.id, type: 'revision', progress, message: `🔁 Revision Update: Child revision "${topic.name}" in ${topic.subject} reached ${progress}% completion.` });
                }
              });

              (selfExams || []).forEach(e => {
                if (String(e.status || '').trim() === 'Completed' && Number(e.alert_dismissed) === 0) {
                  parentAlerts.push({ id: e.id, type: 'exam', message: `🏆 Milestone Reached: Child prelim "${e.name}" scored ${e.score}/${e.total_score} (${calculateALGrade(e.score, e.total_score)})!` });
                }
              });

              collectChildData();
            });
          });
        });
      });
    });
  });
});

app.post('/api/errors/log-with-photo', upload.single('photo'), async (req, res) => {
  const { title, description, category, revisionId, examId, userKey } = req.body;
  if (!req.file) return res.status(400).json({ error: "Photo snapshot file buffer missing." });
  if (!userKey || !title || !description) return res.status(400).json({ error: "Photo keyword, description, and parent phone are required." });
  
  // 1. ADDED: Enforce evidence linking checks ONLY when the parameter is active
  if (requireEvidenceLinking && !revisionId && !examId) {
    return res.status(400).json({ error: 'Missing Target: Evidence linking is mandatory under active settings.' });
  }

  const cleanPhone = userKey.trim();
  const parentPhoneHash = crypto.createHash('sha256').update(cleanPhone).digest('hex');
  const uploadedAt = new Date();
  const monthFolder = `${uploadedAt.getFullYear()}-${String(uploadedAt.getMonth() + 1).padStart(2, '0')}`;
  const safeExtension = path.extname(req.file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.jpg';
  const fileName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExtension}`;
  const relativePath = path.posix.join(parentPhoneHash, monthFolder, fileName);
  const hostUrl = `${req.protocol}://${req.get('host')}`;
  try {
    await mediaStorage.putObject({ objectKey: relativePath, buffer: req.file.buffer, contentType: req.file.mimetype });
  } catch (error) {
    console.error(`${mediaStorage.provider} media upload failed:`, error.message);
    return res.status(502).json({ error: 'Photo storage is temporarily unavailable.' });
  }
  const photoUrl = mediaStorage.getPublicUrl(relativePath, hostUrl);
  db.run("INSERT INTO mistakes_log (name, description, category, photo_url, status, revision_id, exam_id, user_key) VALUES (?, ?, ?, ?, '🔴 Unreviewed', ?, ?, ?)", [title.trim(), description.trim(), category || 'Missing Keywords (OEQ)', photoUrl, revisionId || null, examId || null, cleanPhone], function(err) {
    if (err) return res.status(500).json({ error: err.message }); 
    const mistakeId = this.lastID;
    db.run("INSERT INTO uploaded_files (mistake_id, parent_phone_hash, month_folder, relative_path, original_name, uploaded_at, user_key) VALUES (?, ?, ?, ?, ?, ?, ?)", [mistakeId, parentPhoneHash, monthFolder, relativePath, req.file.originalname, uploadedAt.toISOString(), cleanPhone], function(uploadError) {
      if (uploadError) return res.status(500).json({ error: uploadError.message }); 
      res.json({ success: true, localId: mistakeId, imageUrl: photoUrl, parentPhoneHash, monthFolder });
    });
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    app: config.appName,
    environment: config.nodeEnv,
    timestamp: new Date().toISOString()
  });
});

const PORT = config.port;
if (require.main === module) {
  app.listen(PORT, () => console.log(`🚀 Data-driven mobile app server running securely on Port: ${PORT}`));
}

module.exports = { app, db, config };
