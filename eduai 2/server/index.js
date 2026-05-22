import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import 'dotenv/config';

// SQLite: 优先使用 better-sqlite3（生产推荐，性能最好）
// fallback 到 Node 22+ 内置的 node:sqlite（实验性，但 API 一致）
let Database;
try {
  Database = (await import('better-sqlite3')).default;
} catch (e) {
  const { DatabaseSync } = await import('node:sqlite');
  Database = function(path) {
    const db = new DatabaseSync(path);
    // 适配 better-sqlite3 的 API
    return {
      pragma: (s) => db.exec(`PRAGMA ${s}`),
      exec: (s) => db.exec(s),
      prepare: (s) => {
        const stmt = db.prepare(s);
        return {
          run: (...args) => stmt.run(...args),
          get: (...args) => stmt.get(...args),
          all: (...args) => stmt.all(...args),
        };
      }
    };
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

if (!GEMINI_API_KEY) {
  console.warn('⚠️  GEMINI_API_KEY 未设置 — AI 聊天功能将不可用。请编辑 .env 文件');
}

// ───── 数据库 ─────
const dbPath = path.join(__dirname, 'data.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    session_token TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL,
    last_active INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    content TEXT NOT NULL,
    file_path TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    case_id INTEGER,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    response_ms INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (student_id) REFERENCES students(id),
    FOREIGN KEY (case_id) REFERENCES cases(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_ms INTEGER DEFAULT 0,
    FOREIGN KEY (student_id) REFERENCES students(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_student ON messages(student_id);
  CREATE INDEX IF NOT EXISTS idx_messages_case ON messages(case_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id);
`);

// ───── 文件上传 ─────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safe = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext;
    cb(null, safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ───── App ─────
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/uploads', express.static(uploadDir));

// ───── 工具函数 ─────
function now() { return Date.now(); }

function getStudentByToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM students WHERE session_token = ?').get(token);
}

function authStudent(req, res, next) {
  const token = req.headers['x-session-token'] || req.query.token;
  const student = getStudentByToken(token);
  if (!student) return res.status(401).json({ error: '未登录或会话已过期' });
  req.student = student;
  // 更新最后活跃时间
  db.prepare('UPDATE students SET last_active = ? WHERE id = ?').run(now(), student.id);
  next();
}

function authAdmin(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.query.password;
  if (pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: '管理员密码错误' });
  next();
}

// ───── 学生端 API ─────

// 注册/登录（用姓名）
app.post('/api/login', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name || name.length > 50) return res.status(400).json({ error: '请输入有效姓名（1–50字）' });

  const token = crypto.randomBytes(24).toString('hex');
  const ts = now();
  const result = db.prepare(
    'INSERT INTO students (name, session_token, created_at, last_active) VALUES (?, ?, ?, ?)'
  ).run(name, token, ts, ts);

  // 开始一个新 session
  db.prepare('INSERT INTO sessions (student_id, started_at) VALUES (?, ?)').run(result.lastInsertRowid, ts);

  res.json({ token, name, student_id: result.lastInsertRowid });
});

// 心跳：维持 session 时长
app.post('/api/heartbeat', authStudent, (req, res) => {
  const student = req.student;
  const ts = now();
  // 找当前学生最近未结束的 session
  const sess = db.prepare(
    'SELECT * FROM sessions WHERE student_id = ? ORDER BY started_at DESC LIMIT 1'
  ).get(student.id);

  if (sess) {
    const duration = ts - sess.started_at;
    db.prepare('UPDATE sessions SET duration_ms = ?, ended_at = ? WHERE id = ?')
      .run(duration, ts, sess.id);
  }
  res.json({ ok: true });
});

// 获取案例列表
app.get('/api/cases', authStudent, (req, res) => {
  const cases = db.prepare(
    'SELECT id, title, description, file_path, created_at FROM cases ORDER BY created_at DESC'
  ).all();
  res.json({ cases });
});

// 获取单个案例
app.get('/api/cases/:id', authStudent, (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '案例不存在' });
  res.json({ case: c });
});

// 获取学生的聊天历史（按案例分组）
app.get('/api/messages', authStudent, (req, res) => {
  const caseId = req.query.case_id || null;
  let rows;
  if (caseId) {
    rows = db.prepare(
      'SELECT id, role, content, created_at FROM messages WHERE student_id = ? AND case_id = ? ORDER BY created_at ASC'
    ).all(req.student.id, caseId);
  } else {
    rows = db.prepare(
      'SELECT id, role, content, created_at FROM messages WHERE student_id = ? AND case_id IS NULL ORDER BY created_at ASC'
    ).all(req.student.id);
  }
  res.json({ messages: rows });
});

// 聊天：调 Gemini
app.post('/api/chat', authStudent, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: '服务器未配置 GEMINI_API_KEY' });
  }
  const { message, case_id } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: '消息不能为空' });
  }
  if (message.length > 8000) {
    return res.status(400).json({ error: '消息过长（限 8000 字符）' });
  }

  // 校验 case_id
  let validCaseId = null;
  let currentCase = null;
  if (case_id) {
    currentCase = db.prepare('SELECT title, description, content FROM cases WHERE id = ?').get(case_id);
    if (!currentCase) {
      return res.status(400).json({ error: '案例不存在' });
    }
    validCaseId = case_id;
  }

  const startTs = now();

  // 保存用户消息
  const userMsgResult = db.prepare(
    'INSERT INTO messages (student_id, case_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(req.student.id, validCaseId, 'user', message, startTs);
  const userMsgId = userMsgResult.lastInsertRowid;

  // 拼接上下文：取该案例（或无案例）的最近 20 条消息
  let history;
  if (validCaseId) {
    history = db.prepare(
      'SELECT role, content FROM messages WHERE student_id = ? AND case_id = ? ORDER BY created_at DESC LIMIT 20'
    ).all(req.student.id, validCaseId).reverse();
  } else {
    history = db.prepare(
      'SELECT role, content FROM messages WHERE student_id = ? AND case_id IS NULL ORDER BY created_at DESC LIMIT 20'
    ).all(req.student.id).reverse();
  }

  // 系统提示：教学语气
  let systemPrompt = `你是一位善于引导学生的教学助手。你的目标不是直接给出答案,而是通过提问、举例、类比来启发学生思考。回答要清晰、友好,使用学生熟悉的语言。当学生回答正确时给予肯定;当学生遇到困难时,先理解他们的思路,再温和地引导。`;

  if (currentCase) {
    systemPrompt += `\n\n当前讨论的案例:\n标题: ${currentCase.title}\n${currentCase.description ? '描述: ' + currentCase.description + '\n' : ''}内容:\n${currentCase.content}\n\n请围绕这个案例与学生${req.student.name}讨论。`;
  } else {
    systemPrompt += `\n\n学生姓名: ${req.student.name}`;
  }

  // 转成 Gemini 格式
  const contents = history.map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }]
  }));

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
        }
      })
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error:', errText);
      // 回滚用户消息，避免脏数据
      db.prepare('DELETE FROM messages WHERE id = ?').run(userMsgId);
      return res.status(502).json({ error: 'Gemini API 调用失败，请稍后重试', detail: errText.slice(0, 300) });
    }

    const data = await geminiRes.json();
    const reply = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '(AI 无回复，请重新提问)';
    const elapsed = now() - startTs;

    // 保存助手消息
    db.prepare(
      'INSERT INTO messages (student_id, case_id, role, content, response_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.student.id, validCaseId, 'assistant', reply, elapsed, now());

    res.json({ reply, elapsed_ms: elapsed });
  } catch (err) {
    console.error(err);
    db.prepare('DELETE FROM messages WHERE id = ?').run(userMsgId);
    res.status(500).json({ error: '调用 AI 失败', detail: err.message });
  }
});

// ───── 教师后台 API ─────

// 验证密码
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: '密码错误' });
  res.json({ ok: true });
});

// 概览统计
app.get('/api/admin/stats', authAdmin, (req, res) => {
  const totalStudents = db.prepare('SELECT COUNT(*) as c FROM students').get().c;
  const totalMessages = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  const totalCases = db.prepare('SELECT COUNT(*) as c FROM cases').get().c;
  const totalUserMessages = db.prepare("SELECT COUNT(*) as c FROM messages WHERE role='user'").get().c;
  res.json({ totalStudents, totalMessages, totalCases, totalUserMessages });
});

// 学生列表 + 使用时长
app.get('/api/admin/students', authAdmin, (req, res) => {
  const students = db.prepare(`
    SELECT
      s.id, s.name, s.created_at, s.last_active,
      COALESCE(SUM(ss.duration_ms), 0) as total_duration_ms,
      (SELECT COUNT(*) FROM messages m WHERE m.student_id = s.id AND m.role='user') as prompt_count
    FROM students s
    LEFT JOIN sessions ss ON ss.student_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `).all();
  res.json({ students });
});

// 某个学生的所有 prompt 记录
app.get('/api/admin/students/:id/messages', authAdmin, (req, res) => {
  const messages = db.prepare(`
    SELECT m.*, c.title as case_title
    FROM messages m
    LEFT JOIN cases c ON c.id = m.case_id
    WHERE m.student_id = ?
    ORDER BY m.created_at ASC
  `).all(req.params.id);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  res.json({ student, messages });
});

// 案例使用频率
app.get('/api/admin/case-usage', authAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT
      c.id, c.title, c.created_at,
      COUNT(DISTINCT m.student_id) as unique_students,
      COUNT(m.id) as total_messages
    FROM cases c
    LEFT JOIN messages m ON m.case_id = c.id
    GROUP BY c.id
    ORDER BY total_messages DESC
  `).all();
  res.json({ cases: rows });
});

// 创建案例
app.post('/api/admin/cases', authAdmin, upload.single('file'), (req, res) => {
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const content = (req.body.content || '').trim();
  if (!title || !content) return res.status(400).json({ error: '标题和内容必填' });

  const filePath = req.file ? '/uploads/' + req.file.filename : null;
  const result = db.prepare(
    'INSERT INTO cases (title, description, content, file_path, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(title, description, content, filePath, now());

  res.json({ id: result.lastInsertRowid });
});

// 删除案例
app.delete('/api/admin/cases/:id', authAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (c && c.file_path) {
    const filename = path.basename(c.file_path);
    const fullPath = path.join(uploadDir, filename);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }
  db.prepare('DELETE FROM cases WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// 列出案例（管理端可看完整内容）
app.get('/api/admin/cases', authAdmin, (req, res) => {
  const cases = db.prepare('SELECT * FROM cases ORDER BY created_at DESC').all();
  res.json({ cases });
});

// ───── 路由 ─────
app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

// 全局错误处理（multer 文件太大等）
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件过大（限 10MB）' });
  res.status(500).json({ error: err.message || '服务器错误' });
});

app.listen(PORT, () => {
  console.log(`\n  ✦ 教学协作平台已启动`);
  console.log(`  → 学生端:   http://localhost:${PORT}/`);
  console.log(`  → 教师后台: http://localhost:${PORT}/admin`);
  console.log(`  → 模型:     ${GEMINI_MODEL}`);
  console.log(`  → 数据库:   ${dbPath}\n`);
});
