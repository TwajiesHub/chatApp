import express from "express";
import { createOriginPolicy } from "./origins.js";
const isAllowedOrigin = createOriginPolicy();
import compression from "compression";
import { WebSocketServer, WebSocket } from "ws";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
const dir = process.env.DATA_DIR || "./data";
mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(resolve(dir, "study.sqlite"));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE, name TEXT, level TEXT, school TEXT, salt TEXT, hash TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT,expires INTEGER);
CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,name TEXT,kind TEXT,end_at INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS members(room_id TEXT,user_id TEXT,PRIMARY KEY(room_id,user_id));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,room_id TEXT,user_id TEXT,body TEXT,file_id TEXT,client_id TEXT,created INTEGER,UNIQUE(user_id,client_id));
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,room_id TEXT,name TEXT,type TEXT,bytes BLOB);
CREATE TABLE IF NOT EXISTS scores(user_id TEXT,quiz TEXT,score INTEGER,PRIMARY KEY(user_id,quiz));
INSERT OR IGNORE INTO rooms(id,name,kind) VALUES('study','SS study circle','study');`);
const app = express();
app.use(compression());
app.disable("x-powered-by");
app.use(express.json({ limit: "3mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
  const origin = req.headers.origin;
  if (
    origin &&
    !isAllowedOrigin(origin) &&
    !["GET", "HEAD"].includes(req.method)
  ) {
    return res.status(403).json({ error: "Invalid origin" });
  }
  if (req.path.startsWith("/api")) {
    res.vary("Origin");
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});
const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  name: u.name,
  level: u.level,
  school: u.school,
});
const getUser = (req) => {
  const token = /\bsid=([a-f0-9]+)/.exec(req.headers.cookie || "")?.[1];
  return (
    token &&
    db
      .prepare(
        "SELECT users.* FROM users JOIN sessions ON users.id=sessions.user_id WHERE token=? AND expires>?",
      )
      .get(token, Date.now())
  );
};
const auth = (req, res, next) => {
  req.user = getUser(req);
  if (!req.user) return res.status(401).json({ error: "Please sign in" });
  next();
};
const member = (uid, rid) =>
  !!db
    .prepare("SELECT 1 FROM members WHERE room_id=? AND user_id=?")
    .get(rid, uid);
const access = (req, res, next) => {
  if (!member(req.user.id, req.params.id))
    return res.status(403).json({ error: "Join this conversation first" });
  next();
};
const attempts = new Map();
app.post("/api/auth/:action", (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || now - a.start > 600000) {
    a = { start: now, n: 0 };
    attempts.set(ip, a);
  }
  if (++a.n > 40)
    return res
      .status(429)
      .json({ error: "Too many attempts. Try again in 10 minutes." });
  const { username, password, name, level, school = "" } = req.body;
  if (
    !/^[a-z0-9_]{3,24}$/.test(username || "") ||
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 128
  )
    return res.status(400).json({
      error:
        "Use a 3–24 character lowercase username and an 8–128 character password.",
    });
  let user = db.prepare("SELECT * FROM users WHERE username=?").get(username);
  if (req.params.action === "register") {
    if (user) return res.status(409).json({ error: "Username already taken" });
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 60 ||
      !["JSS1", "JSS2", "JSS3", "SS1", "SS2", "SS3"].includes(level) ||
      typeof school !== "string" ||
      school.length > 100
    )
      return res.status(400).json({ error: "Enter a name and class level" });
    const salt = randomBytes(16).toString("hex");
    const id = randomUUID();
    db.prepare("INSERT INTO users VALUES(?,?,?,?,?,?,?)").run(
      id,
      username,
      name.trim(),
      level,
      school,
      salt,
      scryptSync(password, salt, 64).toString("hex"),
    );
    user = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  } else if (
    req.params.action !== "login" ||
    !user ||
    !timingSafeEqual(
      Buffer.from(user.hash, "hex"),
      scryptSync(password, user.salt, 64),
    )
  )
    return res.status(401).json({ error: "Username or password is incorrect" });
  db.prepare("INSERT OR IGNORE INTO members VALUES(?,?)").run("study", user.id);
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    token,
    user.id,
    now + 7 * 86400000,
  );
  res.setHeader(
    "Set-Cookie",
    `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.SECURE_COOKIE === "1" ? "; Secure" : ""}`,
  );
  res.json(publicUser(user));
});
app.post("/api/logout", auth, (req, res) => {
  const token = /\bsid=([a-f0-9]+)/.exec(req.headers.cookie || "")?.[1];
  db.prepare("DELETE FROM sessions WHERE token=?").run(token);
  for (const c of wss.clients)
    if (c.uid === req.user.id) c.close(4001, "Signed out");
  res.setHeader(
    "Set-Cookie",
    "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
  );
  res.json({ ok: true });
});
app.get("/api/me", auth, (req, res) => res.json(publicUser(req.user)));
app.get("/api/rooms", auth, (req, res) =>
  res.json(
    db
      .prepare(
        "SELECT rooms.* FROM rooms JOIN members ON rooms.id=members.room_id WHERE user_id=?",
      )
      .all(req.user.id),
  ),
);
app.get("/api/people", auth, (req, res) =>
  res.json(
    db
      .prepare("SELECT id,name,username,level FROM users WHERE id!=? LIMIT 100")
      .all(req.user.id),
  ),
);
app.post("/api/rooms", auth, (req, res) => {
  const { name, users } = req.body;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 60 ||
    !Array.isArray(users) ||
    users.length < 1 ||
    users.length > 5 ||
    users.some((id) => !db.prepare("SELECT 1 FROM users WHERE id=?").get(id))
  )
    return res
      .status(400)
      .json({ error: "Choose 1–5 classmates and a conversation name" });
  const id = randomUUID();
  db.prepare("INSERT INTO rooms(id,name,kind) VALUES(?,?,?)").run(
    id,
    name.trim(),
    users.length === 1 ? "direct" : "group",
  );
  for (const uid of new Set([req.user.id, ...users]))
    db.prepare("INSERT INTO members VALUES(?,?)").run(id, uid);
  res.json({ id });
});
const messageRows = (rid) =>
  db
    .prepare(
      `SELECT m.*,u.name,f.name AS file_name,f.type AS file_type,length(f.bytes) AS file_size FROM messages m JOIN users u ON m.user_id=u.id LEFT JOIN files f ON f.id=m.file_id WHERE m.room_id=? ORDER BY m.id DESC LIMIT 80`,
    )
    .all(rid)
    .reverse();
app.get("/api/rooms/:id/messages", auth, access, (req, res) =>
  res.json(messageRows(req.params.id)),
);
app.post("/api/rooms/:id/messages", auth, access, (req, res) => {
  const { body = "", clientId, file } = req.body;
  if (
    typeof body !== "string" ||
    body.length > 2000 ||
    typeof clientId !== "string" ||
    clientId.length > 100 ||
    (!body.trim() && !file)
  )
    return res
      .status(400)
      .json({ error: "Write a message (up to 2,000 characters)" });
  const existing = db
    .prepare("SELECT id FROM messages WHERE user_id=? AND client_id=?")
    .get(req.user.id, clientId);
  if (existing) return res.json(existing);
  let fid = null;
  if (file) {
    if (
      typeof file.name !== "string" ||
      file.name.length > 120 ||
      ![
        "image/webp",
        "image/jpeg",
        "image/png",
        "application/pdf",
        "audio/webm",
        "audio/ogg",
        "audio/mp4",
      ].includes(file.type) ||
      typeof file.data !== "string"
    )
      return res
        .status(400)
        .json({ error: "Use an image, PDF or recorded voice note" });
    const bytes = Buffer.from(file.data, "base64");
    if (!bytes.length || bytes.length > 2 * 1024 * 1024)
      return res
        .status(413)
        .json({ error: "File must be under 2 MB after compression" });
    fid = randomUUID();
    db.prepare("INSERT INTO files VALUES(?,?,?,?,?)").run(
      fid,
      req.params.id,
      file.name,
      file.type,
      bytes,
    );
  }
  const result = db
    .prepare(
      "INSERT INTO messages(room_id,user_id,body,file_id,client_id,created) VALUES(?,?,?,?,?,?)",
    )
    .run(req.params.id, req.user.id, body.trim(), fid, clientId, Date.now());
  broadcast(req.params.id, { type: "messages" });
  res.json({ id: Number(result.lastInsertRowid) });
});
app.get("/api/files/:id", auth, (req, res) => {
  const f = db.prepare("SELECT * FROM files WHERE id=?").get(req.params.id);
  if (!f || !member(req.user.id, f.room_id))
    return res.status(404).json({ error: "File unavailable" });
  res.setHeader("Content-Type", f.type);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${f.name.replace(/[^a-zA-Z0-9._ -]/g, "_")}"`,
  );
  res.send(Buffer.from(f.bytes));
});
app.post("/api/rooms/:id/timer", auth, access, (req, res) => {
  if (req.params.id !== "study")
    return res.status(400).json({ error: "Use the study room timer" });
  const endAt = req.body.running ? Date.now() + 25 * 60000 : 0;
  db.prepare("UPDATE rooms SET end_at=? WHERE id=?").run(endAt, req.params.id);
  broadcast(req.params.id, { type: "timer", endAt });
  res.json({ endAt });
});
const questions = [
  { q: "What is 15% of 200?", options: ["15", "30", "45", "60"], answer: 1 },
  {
    q: "Which organ pumps blood around the body?",
    options: ["Lungs", "Liver", "Heart", "Kidney"],
    answer: 2,
  },
  {
    q: "Choose the correct sentence.",
    options: [
      "She go to school.",
      "She goes to school.",
      "She going school.",
      "She gone school.",
    ],
    answer: 1,
  },
];
app.get("/api/quiz", auth, (req, res) =>
  res.json(questions.map(({ answer, ...q }) => q)),
);
app.post("/api/quiz", auth, (req, res) => {
  if (
    !Array.isArray(req.body.answers) ||
    req.body.answers.length !== questions.length
  )
    return res.status(400).json({ error: "Answer all questions" });
  const score = questions.reduce(
    (n, q, i) => n + (req.body.answers[i] === q.answer ? 1 : 0),
    0,
  );
  db.prepare(
    "INSERT INTO scores VALUES(?,?,?) ON CONFLICT(user_id,quiz) DO UPDATE SET score=MAX(score,excluded.score)",
  ).run(req.user.id, "starter", score);
  res.json({ score, total: questions.length });
});
app.get("/api/leaderboard", auth, (req, res) =>
  res.json(
    db
      .prepare(
        "SELECT u.name,u.level,SUM(s.score) AS score FROM scores s JOIN users u ON s.user_id=u.id GROUP BY u.id ORDER BY score DESC,u.name LIMIT 20",
      )
      .all(),
  ),
);
app.get("/api/ice", auth, (req, res) => {
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
  if (
    process.env.TURN_URL &&
    process.env.TURN_USERNAME &&
    process.env.TURN_PASSWORD
  )
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_PASSWORD,
    });
  res.json({ iceServers, relayConfigured: iceServers.length > 1 });
});
app.use(express.static("public", { maxAge: 0 }));
app.use((err, req, res, next) => {
  if (!err.status) console.error("Request failed:", err.message);
  res.status(err.status || 500).json({
    error:
      err.status === 413
        ? "Upload too large"
        : err.status === 400
          ? "Invalid request"
          : "Server error",
  });
});
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64000 });
const broadcast = (rid, data) => {
  for (const c of wss.clients)
    if (c.room === rid && c.readyState === WebSocket.OPEN)
      c.send(JSON.stringify(data));
};
server.on("upgrade", (req, socket, head) => {
  const user = getUser(req);
  const url = new URL(req.url, "http://localhost");
  const rid = url.searchParams.get("room");
  if (
    url.pathname !== "/ws" ||
    !user ||
    !member(user.id, rid) ||
    (req.headers.origin && !isAllowedOrigin(req.headers.origin))
  ) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.uid = user.id;
    ws.authCookie = req.headers.cookie;
    ws.name = user.name;
    ws.room = rid;
    ws.peer = randomUUID();
    ws.alive = true;
    wss.emit("connection", ws);
  });
});
const leave = (ws) => {
  if (ws.call) {
    ws.call = false;
    broadcast(ws.room, { type: "peer-left", peer: ws.peer });
  }
};
wss.on("connection", (ws) => {
  ws.on("pong", () => (ws.alive = true));
  ws.send(
    JSON.stringify({
      type: "welcome",
      peer: ws.peer,
      endAt:
        db.prepare("SELECT end_at FROM rooms WHERE id=?").get(ws.room)
          ?.end_at || 0,
    }),
  );
  ws.on("message", (raw) => {
    if (!getUser({ headers: { cookie: ws.authCookie } })) {
      ws.close(4001, "Session expired");
      return;
    }
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m !== "object" || Array.isArray(m)) return;
    if (m.type === "join-call") {
      if (ws.call) return;
      const peers = [...wss.clients].filter(
        (c) => c.room === ws.room && c.call && c !== ws,
      );
      if (peers.length >= 4) {
        ws.send(JSON.stringify({ type: "call-full" }));
        return;
      }
      ws.call = true;
      ws.send(
        JSON.stringify({
          type: "peers",
          peers: peers.map((c) => ({ peer: c.peer, name: c.name })),
        }),
      );
      broadcast(ws.room, { type: "call-presence", count: peers.length + 1 });
    } else if (m.type === "leave-call") leave(ws);
    else if (m.type === "signal" && ws.call) {
      const target = [...wss.clients].find(
        (c) => c.room === ws.room && c.peer === m.to && c.call,
      );
      if (target)
        target.send(
          JSON.stringify({
            type: "signal",
            from: ws.peer,
            name: ws.name,
            signal: m.signal,
          }),
        );
    }
  });
  ws.on("close", () => leave(ws));
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 30000);
heartbeat.unref();
server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () =>
  console.log("StudyLight listening on port " + (process.env.PORT || 3000)),
);
