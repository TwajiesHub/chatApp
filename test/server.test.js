import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
const port = 13400 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
let server, dir;
async function start() {
  server = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    server.stdout.once("data", resolve);
    server.once("exit", (code) => reject(Error("Server exited " + code)));
    server.stderr.on("data", () => {});
  });
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "studylight-test-"));
  await start();
});
after(async () => {
  server.kill();
  await new Promise((r) => server.once("exit", r));
  await rm(dir, { recursive: true, force: true });
});
async function request(path, body, cookie) {
  const r = await fetch(base + "/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: r.status,
    data: await r.json(),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
const register = async (username) =>
  request("/auth/register", {
    username,
    password: "test-password-123",
    name: username,
    level: "SS2",
  });
const waitMessage = (ws, predicate) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off("message", listener);
      reject(Error("Socket event timed out"));
    }, 4000);
    const listener = (raw) => {
      const m = JSON.parse(raw);
      if (predicate(m)) {
        clearTimeout(t);
        ws.off("message", listener);
        resolve(m);
      }
    };
    ws.on("message", listener);
  });
async function connect(cookie, room) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}`, {
    headers: { cookie, origin: base },
  });
  const welcome = await waitMessage(ws, (m) => m.type === "welcome");
  return { ws, welcome };
}
test("end-to-end auth, private chat, resources, timer, quiz, signaling, restart and logout", async () => {
  assert.equal((await request("/rooms")).status, 401);
  const a = await register("ada");
  const b = await register("bayo");
  const c = await register("chioma");
  assert.equal(a.status, 200);
  assert.ok(!("hash" in a.data));
  assert.equal((await register("ada")).status, 409);
  assert.equal(
    (
      await request("/auth/login", {
        username: "ada",
        password: "bad-password",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/auth/login", {
        username: "ada",
        password: "test-password-123",
      })
    ).status,
    200,
  );
  const room = (
    await request("/rooms", { name: "Revision", users: [b.data.id] }, a.cookie)
  ).data.id;
  assert.equal(
    (await request(`/rooms/${room}/messages`, undefined, c.cookie)).status,
    403,
  );
  const ac = await connect(a.cookie, room),
    bc = await connect(b.cookie, room);
  const event = waitMessage(bc.ws, (m) => m.type === "messages");
  const first = await request(
    `/rooms/${room}/messages`,
    { body: "Hello Bayo", clientId: "one" },
    a.cookie,
  );
  await event;
  const duplicate = await request(
    `/rooms/${room}/messages`,
    { body: "Hello Bayo", clientId: "one" },
    a.cookie,
  );
  assert.equal(first.data.id, duplicate.data.id);
  assert.equal(
    (await request(`/rooms/${room}/messages`, undefined, b.cookie)).data.length,
    1,
  );
  await request(
    `/rooms/${room}/messages`,
    {
      clientId: "pdf",
      file: {
        name: "notes.pdf",
        type: "application/pdf",
        data: Buffer.from("%PDF-1.4 test").toString("base64"),
      },
    },
    a.cookie,
  );
  const messages = (
    await request(`/rooms/${room}/messages`, undefined, b.cookie)
  ).data;
  const fid = messages[1].file_id;
  assert.equal(
    (await fetch(base + "/api/files/" + fid, { headers: { cookie: c.cookie } }))
      .status,
    404,
  );
  assert.equal(
    await (
      await fetch(base + "/api/files/" + fid, { headers: { cookie: b.cookie } })
    ).text(),
    "%PDF-1.4 test",
  );
  const timer = (
    await request("/rooms/study/timer", { running: true }, a.cookie)
  ).data;
  assert.ok(timer.endAt > Date.now());
  assert.equal(
    (await request("/quiz", undefined, a.cookie)).data[0].answer,
    undefined,
  );
  assert.equal(
    (await request("/quiz", { answers: [1, 2, 1] }, a.cookie)).data.score,
    3,
  );
  await request("/quiz", { answers: [0, 0, 0] }, a.cookie);
  assert.equal(
    (await request("/leaderboard", undefined, a.cookie)).data[0].score,
    3,
  );
  let peers = waitMessage(ac.ws, (m) => m.type === "peers");
  ac.ws.send(JSON.stringify({ type: "join-call" }));
  assert.equal((await peers).peers.length, 0);
  peers = waitMessage(bc.ws, (m) => m.type === "peers");
  bc.ws.send(JSON.stringify({ type: "join-call" }));
  assert.equal((await peers).peers[0].peer, ac.welcome.peer);
  const signal = waitMessage(ac.ws, (m) => m.type === "signal");
  bc.ws.send(
    JSON.stringify({
      type: "signal",
      to: ac.welcome.peer,
      signal: { description: { type: "offer", sdp: "test" } },
    }),
  );
  assert.equal((await signal).from, bc.welcome.peer);
  const left = waitMessage(bc.ws, (m) => m.type === "peer-left");
  ac.ws.close();
  await left;
  bc.ws.close();
  server.kill();
  await new Promise((r) => server.once("exit", r));
  await start();
  assert.equal(
    (await request(`/rooms/${room}/messages`, undefined, a.cookie)).data.length,
    2,
  );
  assert.equal(
    (await request("/rooms", undefined, a.cookie)).data.find(
      (r) => r.id === "study",
    ).end_at,
    timer.endAt,
  );
  await request("/logout", {}, a.cookie);
  assert.equal((await request("/me", undefined, a.cookie)).status, 401);
});
test("origin validation blocks cross-site mutations and sockets", async () => {
  const r = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(r.status, 403);
  const u = await register("dami");
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=study`, {
    headers: { cookie: u.cookie, origin: "https://evil.example" },
  });
  const code = await new Promise((resolve) => {
    ws.on("unexpected-response", (_, res) => {
      resolve(res.statusCode);
      ws.terminate();
    });
    ws.on("error", () => {});
  });
  assert.equal(code, 403);
});
test("call capacity is four, malformed signaling does not crash server", async () => {
  const sockets = [];
  try {
    for (let i = 0; i < 5; i++) {
      const u = await register("capacity" + i);
      const c = await connect(u.cookie, "study");
      sockets.push(c.ws);
      c.ws.send("null");
      const result = waitMessage(
        c.ws,
        (m) => m.type === "peers" || m.type === "call-full",
      );
      c.ws.send(JSON.stringify({ type: "join-call" }));
      const m = await result;
      if (i < 4) {
        assert.equal(m.type, "peers");
        assert.equal(m.peers.length, i);
      } else assert.equal(m.type, "call-full");
    }
  } finally {
    for (const ws of sockets) ws.close();
  }
});
test("Render signup, credentialed CORS and signaling work behind an HTTP proxy", async () => {
  const origin = "https://studylight-gg38.onrender.com";
  const response = await fetch(base + "/api/auth/register", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "x-forwarded-proto": "https",
    },
    body: JSON.stringify({
      username: "render_student",
      password: "test-password-123",
      name: "Render Student",
      level: "SS1",
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(
    response.headers.get("access-control-allow-credentials"),
    "true",
  );
  assert.match(response.headers.get("vary"), /Origin/i);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=study`, {
    headers: { cookie, origin },
  });
  await waitMessage(ws, (m) => m.type === "welcome");
  ws.close();
  const preflight = await fetch(base + "/api/auth/register", {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  for (const deniedOrigin of ["https://attacker.onrender.com", "null"]) {
    const denied = await fetch(base + "/api/auth/register", {
      method: "POST",
      headers: { origin: deniedOrigin, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
  }
  const spoofed = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: {
      origin: "https://attacker.example",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "https",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(spoofed.status, 403);
});
