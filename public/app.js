import { StudyCall, qualities, estimate } from "./call.js";
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
let user,
  rooms = [],
  room = "study",
  page = "study",
  socket,
  retry,
  stopped = false,
  attachment = null,
  recording = null,
  recordTimer,
  timerEnd = 0,
  authMode = "register",
  objectUrls = [];
const lowSaved = localStorage.getItem("lowData");
let lowData = lowSaved === null ? true : lowSaved === "true";
$("#low-data").checked = lowData;
const dbPromise = new Promise((resolve, reject) => {
  const r = indexedDB.open("studylight", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
async function stored(key, value) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      "kv",
      value === undefined ? "readonly" : "readwrite",
    );
    const req =
      value === undefined
        ? tx.objectStore("kv").get(key)
        : tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}
async function clearStored() {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
const key = (k) => `${user.id}:${k}`;
let toastTimer;
export function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 5500);
}
async function api(path, body) {
  const r = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) {
    const error = new Error(data.error || "Request failed");
    error.status = r.status;
    throw error;
  }
  return data;
}
const call = new StudyCall({
  send: (data) => {
    if (socket?.readyState !== 1)
      throw Error("Chat connection lost. Reconnect before calling.");
    socket.send(JSON.stringify(data));
  },
  lowData: () => lowData,
  notify: toast,
});
function connection(text, online = false) {
  $("#connection-text").textContent = text;
  $("#connection-dot").style.background = online ? "#709365" : "#c1935e";
}
function authTab(mode) {
  authMode = mode;
  $("#register-fields").hidden = mode === "login";
  $("#register-fields input[name=name]").required = mode === "register";
  $("#register-tab").classList.toggle("selected", mode === "register");
  $("#login-tab").classList.toggle("selected", mode === "login");
  $("#auth-submit").textContent =
    mode === "register" ? "Create my account ↗" : "Sign in ↗";
  $("#auth-form input[name=password]").autocomplete =
    mode === "register" ? "new-password" : "current-password";
  $("#auth-error").textContent = "";
}
$("#register-tab").onclick = () => authTab("register");
$("#login-tab").onclick = () => authTab("login");
$("#auth-form").onsubmit = async (e) => {
  e.preventDefault();
  $("#auth-submit").disabled = true;
  try {
    const data = Object.fromEntries(new FormData(e.target));
    user = await api("/auth/" + authMode, data);
    await stored("user", user);
    e.target.reset();
    await enter();
  } catch (err) {
    $("#auth-error").textContent = err.message;
  } finally {
    $("#auth-submit").disabled = false;
  }
};
async function enter() {
  stopped = false;
  $("#auth-screen").hidden = true;
  $("#app").hidden = false;
  $("#profile-name").textContent = user.name;
  $("#profile-level").textContent =
    user.level + (user.school ? " · " + user.school : "");
  $("#avatar").textContent = user.name[0].toUpperCase();
  updateLow();
  try {
    rooms = await api("/rooms");
    await stored(key("rooms"), rooms);
  } catch {
    rooms = (await stored(key("rooms"))) || [
      { id: "study", name: "SS study circle", kind: "study" },
    ];
  }
  room = "study";
  await loadMessages();
  connect();
  await flushOutbox();
}
$("#sign-out").onclick = $("#profile-button").onclick = async () => {
  if (
    !confirm(
      "Sign out and remove downloaded resources and recent chats from this device?",
    )
  )
    return;
  try {
    await api("/logout", {});
  } catch {
    toast("Connect to the internet to sign out securely.");
    return;
  }
  stopped = true;
  clearTimeout(retry);
  call.leave();
  socket?.close();
  await clearStored();
  user = null;
  $("#app").hidden = true;
  $("#auth-screen").hidden = false;
  $("#messages").replaceChildren();
};
function connect() {
  clearTimeout(retry);
  if (stopped || !user) return;
  const previous = socket;
  socket = null;
  previous?.close();
  connection(navigator.onLine ? "Connecting…" : "Offline · saved chats");
  const s = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws?room=${encodeURIComponent(room)}`,
  );
  socket = s;
  s.onopen = () => {
    if (s !== socket) return;
    connection("Connected · light on data", true);
    loadMessages();
    flushOutbox();
  };
  s.onmessage = async (e) => {
    if (s !== socket) return;
    const m = JSON.parse(e.data);
    if (m.type === "messages") loadMessages();
    else if (m.type === "welcome" || m.type === "timer") {
      timerEnd = m.endAt;
      renderTimer();
    } else call.handle(m);
  };
  s.onclose = (e) => {
    if (s !== socket || stopped) return;
    call.leave(false);
    connection("Reconnecting · chats saved");
    if (e.code === 4001) {
      stopped = true;
      toast("Session ended. Sign in again.");
      $("#app").hidden = true;
      $("#auth-screen").hidden = false;
      return;
    }
    retry = setTimeout(
      connect,
      Math.min(15000, navigator.onLine ? 4000 : 12000),
    );
  };
  s.onerror = () => connection("Connection interrupted");
}
window.addEventListener("online", () => {
  if (user && !stopped) connect();
});
window.addEventListener("offline", () => connection("Offline · saved chats"));
async function loadMessages() {
  const rid = room;
  let messages;
  try {
    messages = await api(`/rooms/${rid}/messages`);
    await stored(key("messages:" + rid), messages);
  } catch {
    messages = (await stored(key("messages:" + rid))) || [];
  }
  if (rid !== room) return;
  const pending = ((await stored(key("outbox"))) || []).filter(
    (m) => m.room === rid,
  );
  renderMessages([
    ...messages,
    ...pending
      .filter((p) => !messages.some((m) => m.client_id === p.clientId))
      .map((p) => ({
        name: user.name,
        user_id: user.id,
        body: p.body,
        created: p.created,
        pending: true,
      })),
  ]);
}
function renderMessages(messages) {
  const box = $("#messages");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  const empty = !box.children.length;
  box.replaceChildren();
  if (!messages.length) {
    const empty = el("div", "empty-state");
    empty.append(
      el("div", "empty-icon", "✳"),
      el("h3", "", "Make room for a good question."),
      el(
        "p",
        "",
        "Say hello, share a tricky question, or invite a friend to study. Your conversation starts here.",
      ),
    );
    box.append(empty);
    return;
  }
  for (const m of messages) {
    const row = el(
      "article",
      "message" + (m.user_id === user.id ? " mine" : ""),
    );
    const avatar = el("span", "message-avatar", m.name[0].toUpperCase());
    const wrap = el("div");
    const meta = el("div", "message-meta");
    meta.append(
      el("strong", "", m.user_id === user.id ? "You" : m.name),
      el(
        "span",
        "",
        m.pending
          ? "Waiting to send"
          : new Date(m.created).toLocaleTimeString("en-NG", {
              hour: "2-digit",
              minute: "2-digit",
            }),
      ),
    );
    const bubble = el("div", "bubble", m.body);
    if (m.file_id) {
      const button = el(
        "button",
        "",
        `${m.file_type.startsWith("audio/") ? "♩" : "↓"} ${m.file_name} · ${formatBytes(m.file_size)}`,
      );
      button.onclick = () => download(m, button);
      bubble.append(button);
    }
    wrap.append(meta, bubble);
    row.append(avatar, wrap);
    box.append(row);
  }
  if (nearBottom || empty) box.scrollTop = box.scrollHeight;
}
const formatBytes = (b) =>
  b < 1024
    ? b + " B"
    : b < 1048576
      ? Math.round(b / 1024) + " KB"
      : (b / 1048576).toFixed(1) + " MB";
let flushing = false;
async function flushOutbox() {
  if (flushing || !user) return;
  flushing = true;
  try {
    let list = (await stored(key("outbox"))) || [];
    for (const m of [...list]) {
      try {
        await api(`/rooms/${m.room}/messages`, {
          body: m.body,
          clientId: m.clientId,
        });
        list = ((await stored(key("outbox"))) || []).filter(
          (x) => x.clientId !== m.clientId,
        );
        await stored(key("outbox"), list);
      } catch (err) {
        if (err.status && err.status < 500 && err.status !== 401) {
          toast("A queued message could not be sent: " + err.message);
        }
        break;
      }
    }
    await loadMessages();
  } finally {
    flushing = false;
  }
}
$("#message-form").onsubmit = async (e) => {
  e.preventDefault();
  const body = $("#message-input").value.trim();
  if (!body && !attachment) return;
  if (recording) {
    toast("Stop recording before sending.");
    return;
  }
  const clientId = crypto.randomUUID();
  const file = attachment;
  const button = $("#message-form .send-button");
  button.disabled = true;
  try {
    if (file) {
      await api(`/rooms/${room}/messages`, { body, clientId, file });
    } else {
      const out = (await stored(key("outbox"))) || [];
      if (out.length >= 100)
        throw Error(
          "You have 100 queued messages. Reconnect before sending more.",
        );
      out.push({ body, clientId, room, created: Date.now() });
      await stored(key("outbox"), out);
    }
    $("#message-input").value = "";
    attachment = null;
    renderAttachment();
    await loadMessages();
    await flushOutbox();
  } catch (err) {
    toast(
      file && !err.status
        ? "Upload failed. Your attachment is kept here; retry when connected."
        : err.message,
    );
  } finally {
    button.disabled = false;
  }
};
function renderAttachment() {
  const box = $("#attachment-preview");
  box.replaceChildren();
  box.hidden = !attachment;
  if (attachment) {
    box.append(
      el(
        "span",
        "",
        `${attachment.name} · ${formatBytes(Math.ceil(attachment.data.length * 0.75))}`,
      ),
    );
    const b = el("button", "", "×");
    b.type = "button";
    b.setAttribute("aria-label", "Remove attachment");
    b.onclick = () => {
      attachment = null;
      renderAttachment();
    };
    box.append(b);
  }
}
$("#attach-button").onclick = () => {
  if (recording) return toast("Stop your voice note first.");
  $("#file-input").click();
};
async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  const max = lowData ? 1000 : 1600;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(Error("Image compression unavailable"))),
      "image/webp",
      lowData ? 0.55 : 0.72,
    ),
  );
}
const base64 = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
$("#file-input").onchange = async (e) => {
  const original = e.target.files[0];
  e.target.value = "";
  if (!original) return;
  try {
    if (original.size > 15 * 1048576)
      throw Error("Choose a file under 15 MB before compression.");
    let blob = original;
    let name = original.name;
    if (original.type.startsWith("image/")) {
      blob = await compressImage(original);
      name = name.replace(/\.[^.]*$/, "") + ".webp";
    } else if (original.type !== "application/pdf")
      throw Error("Choose an image or PDF.");
    if (blob.size > 2 * 1048576)
      throw Error(
        "Files must be under 2 MB after compression. Split a large PDF first.",
      );
    if (
      blob.size > 250 * 1024 &&
      !confirm(
        `This upload uses about ${formatBytes(blob.size)}. Send it on your current connection?`,
      )
    )
      return;
    attachment = {
      name: name.slice(0, 120),
      type: blob.type,
      data: await base64(blob),
    };
    renderAttachment();
    toast(
      original === blob
        ? "Attachment ready."
        : `Image compressed: ${formatBytes(original.size)} → ${formatBytes(blob.size)}`,
    );
  } catch (err) {
    toast(err.message);
  }
};
$("#record-button").onclick = async () => {
  if (recording) {
    recording.stop();
    return;
  }
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
      throw Error("Voice recording needs a supported browser and HTTPS.");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    const type = [
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ].find((t) => MediaRecorder.isTypeSupported(t));
    if (!type) {
      stream.getTracks().forEach((t) => t.stop());
      throw Error("This browser cannot record a supported audio format.");
    }
    const recorder = new MediaRecorder(stream, {
      mimeType: type,
      audioBitsPerSecond: 16000,
    });
    const parts = [];
    recording = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size) parts.push(e.data);
    };
    recorder.onstop = async () => {
      clearTimeout(recordTimer);
      stream.getTracks().forEach((t) => t.stop());
      recording = null;
      $("#record-button").textContent = "♩";
      $("#composer-status").textContent =
        "Text first. A little data goes a long way.";
      const blob = new Blob(parts, { type: type.split(";")[0] });
      if (blob.size > 2 * 1048576)
        return toast("Recording too large. Try a shorter note.");
      attachment = {
        name:
          "Voice note." +
          (type.includes("webm")
            ? "webm"
            : type.includes("ogg")
              ? "ogg"
              : "m4a"),
        type: blob.type,
        data: await base64(blob),
      };
      renderAttachment();
    };
    recorder.start();
    $("#record-button").textContent = "■";
    $("#composer-status").textContent =
      "Recording · tap ■ to stop · 60 seconds max · ~120 KB";
    recordTimer = setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, 60000);
  } catch (err) {
    toast(err.message);
  }
};
async function download(m, button) {
  try {
    let files = (await stored(key("resources"))) || [];
    let saved = files.find((f) => f.id === m.file_id);
    if (!saved) {
      if (
        m.file_size > 250 * 1024 &&
        !confirm(
          `Download ${formatBytes(m.file_size)} and save for offline use?`,
        )
      )
        return;
      button.disabled = true;
      const r = await fetch("/api/files/" + m.file_id);
      if (!r.ok)
        throw Error("Cannot download. Check your connection and try again.");
      const blob = await r.blob();
      if (files.reduce((s, f) => s + f.blob.size, 0) + blob.size > 30 * 1048576)
        throw Error(
          "Offline storage limit is 30 MB. Remove a saved resource first.",
        );
      saved = { id: m.file_id, name: m.file_name, type: m.file_type, blob };
      files.push(saved);
      await stored(key("resources"), files);
      toast("Saved for offline use on this device.");
    }
    openResource(saved, button.parentElement);
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}
function openResource(file, container) {
  const url = URL.createObjectURL(file.blob);
  objectUrls.push(url);
  if (file.type.startsWith("audio/")) {
    container.querySelector("audio")?.remove();
    const audio = el("audio");
    audio.controls = true;
    audio.src = url;
    container.append(audio);
  } else if (file.type.startsWith("image/")) {
    container.querySelector("img")?.remove();
    const image = el("img", "saved-image");
    image.alt = file.name;
    image.src = url;
    container.append(image);
  } else {
    const a = el("a");
    a.href = url;
    a.download = file.name;
    a.click();
  }
}
async function resources() {
  const box = $("#resource-list");
  box.replaceChildren();
  const files = (await stored(key("resources"))) || [];
  if (!files.length) {
    box.append(
      el(
        "p",
        "muted",
        "No saved resources yet. Download an attachment from a conversation to keep it here.",
      ),
    );
    return;
  }
  for (const f of files) {
    const card = el("article", "tile");
    card.append(
      el("h3", "", f.name),
      el("p", "", formatBytes(f.blob.size) + " · Available offline"),
    );
    const open = el("button", "outline", "Open saved resource");
    open.onclick = () => openResource(f, card);
    const remove = el("button", "outline", "Remove");
    remove.onclick = async () => {
      await stored(
        key("resources"),
        files.filter((x) => x.id !== f.id),
      );
      resources();
    };
    card.append(open, document.createTextNode(" "), remove);
    box.append(card);
  }
}
const titles = {
  study: [
    "BETTER, TOGETHER",
    "A little focus goes a long way.",
    "Pull up a chair. Your next “I get it!” is closer than you think.",
  ],
  chats: [
    "YOUR STUDY PEOPLE",
    "Good questions. Great conversations.",
    "A quiet place to work things out with your classmates.",
  ],
  resources: [
    "KEEP THE GOOD STUFF",
    "Your bag of bright ideas.",
    "Download once. Come back to it, even without a connection.",
  ],
  quiz: [
    "A LITTLE PRACTICE",
    "Small questions. Growing confidence.",
    "Try a quick warm-up and see what you know.",
  ],
  leaderboard: [
    "KEEP SHOWING UP",
    "Every little win counts.",
    "A friendly nudge to keep learning, one question at a time.",
  ],
};
async function navigate(next) {
  page = next;
  for (const p of document.querySelectorAll(".page"))
    p.hidden = p.id !== next + "-page";
  for (const b of document.querySelectorAll("nav button"))
    b.classList.toggle("active", b.dataset.page === next);
  const [eye, title, desc] = titles[next];
  $("#page-eyebrow").textContent = eye;
  $("#page-title").textContent = title;
  $("#page-description").textContent = desc;
  $("#breadcrumb").textContent =
    "Your space / " +
    {
      study: "Study room",
      chats: "Messages",
      resources: "My resources",
      quiz: "Quick quiz",
      leaderboard: "Leaderboard",
    }[next];
  if (next === "study") {
    if (room !== "study") await switchRoom("study");
    $(".room-main").append($("#chat-mount .chat-card") || $(".chat-card"));
    $("#chat-title").textContent = "The conversation";
    $("#chat-subtitle").textContent = "A good question helps everyone.";
  }
  if (next === "chats") await renderRooms();
  if (next === "resources") await resources();
  if (next === "quiz") await quiz();
  if (next === "leaderboard") await leaders();
}
for (const b of document.querySelectorAll("nav button"))
  b.onclick = () => navigate(b.dataset.page).catch((e) => toast(e.message));
async function switchRoom(id) {
  if (room === id) return;
  if (call.active) {
    call.leave();
    toast("You left the call when switching conversations.");
  }
  if (recording) {
    await new Promise((resolve) => {
      recording.addEventListener("stop", () => setTimeout(resolve, 0), {
        once: true,
      });
      recording.stop();
    });
  }
  attachment = null;
  renderAttachment();
  room = id;
  timerEnd = rooms.find((r) => r.id === id)?.end_at || 0;
  await loadMessages();
  connect();
}
async function renderRooms() {
  try {
    rooms = await api("/rooms");
    await stored(key("rooms"), rooms);
  } catch {}
  const list = $("#room-list");
  list.replaceChildren();
  for (const r of rooms.filter((r) => r.id !== "study")) {
    const b = el("button", "tile");
    b.append(
      el(
        "span",
        "eyebrow",
        r.kind === "direct" ? "PRIVATE CONVERSATION" : "SMALL GROUP",
      ),
      el("h3", "", r.name),
      el("p", "", "Open conversation ↗"),
    );
    b.onclick = async () => {
      await switchRoom(r.id);
      $("#chat-mount").append($(".chat-card"));
      $("#chat-title").textContent = r.name;
      $("#chat-subtitle").textContent =
        "Only invited classmates can read this chat.";
    };
    list.append(b);
  }
  if (!list.children.length)
    list.append(
      el(
        "p",
        "muted",
        "Start a conversation with a classmate. New accounts appear when they join.",
      ),
    );
}
$("#new-chat").onclick = async () => {
  try {
    const people = await api("/people");
    const box = $("#people-list");
    box.replaceChildren();
    for (const p of people) {
      const label = el("label");
      const input = el("input");
      input.type = "checkbox";
      input.name = "users";
      input.value = p.id;
      label.append(
        input,
        document.createTextNode(`${p.name} · @${p.username} · ${p.level}`),
      );
      box.append(label);
    }
    if (!people.length)
      box.append(
        el(
          "p",
          "muted",
          "No classmates yet. Ask a friend to create an account on this server.",
        ),
      );
    $("#new-chat-dialog").showModal();
  } catch (err) {
    toast(err.message);
  }
};
$("#close-chat-dialog").onclick = () => $("#new-chat-dialog").close();
$("#new-chat-form").onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const result = await api("/rooms", {
      name: f.get("name"),
      users: f.getAll("users"),
    });
    $("#new-chat-dialog").close();
    e.target.reset();
    await renderRooms();
    await switchRoom(result.id);
    $("#chat-mount").append($(".chat-card"));
    $("#chat-title").textContent = f.get("name");
  } catch (err) {
    toast(err.message);
  }
};
function renderTimer() {
  const left = timerEnd
    ? Math.max(0, Math.ceil((timerEnd - Date.now()) / 1000))
    : 1500;
  const mins = String(Math.floor(left / 60)).padStart(2, "0");
  const secs = String(left % 60).padStart(2, "0");
  $("#timer").textContent = mins + ":" + secs;
  $("#timer-button").textContent =
    timerEnd > Date.now()
      ? "■  End session for everyone"
      : "▷  Start a focus session";
  if (timerEnd && left === 0) {
    timerEnd = 0;
    toast("Focus session complete. Take a short break!");
  }
}
setInterval(renderTimer, 1000);
$("#timer-button").onclick = async () => {
  try {
    if (!navigator.onLine)
      throw Error("Connect to sync the timer with everyone.");
    const t = await api("/rooms/study/timer", {
      running: !(timerEnd > Date.now()),
    });
    timerEnd = t.endAt;
    renderTimer();
  } catch (err) {
    toast(err.message);
  }
};
function updateLow() {
  localStorage.setItem("lowData", lowData);
  $("#data-mode-label").textContent = lowData
    ? "On · video capped at Low"
    : "Off · choose your call quality";
  $("#pre-quality").disabled = lowData;
  $("#live-quality").disabled = lowData;
  if (lowData) {
    $("#pre-quality").value = "low";
    $("#live-quality").value = "low";
    if (call.active) call.setQuality("low");
  }
  updateEstimate();
}
$("#low-data").onchange = (e) => {
  lowData = e.target.checked;
  updateLow();
  toast(
    lowData
      ? "Low-data mode on. Video capped at 180p."
      : "Low-data mode off. Check your call quality before joining.",
  );
};
function updateEstimate() {
  const q = $("#pre-quality").value;
  const video = $("#pre-video").checked;
  $("#pre-estimate").textContent =
    `About ${estimate(q, video)} MB for 10 minutes`;
}
$("#pre-quality").onchange = updateEstimate;
$("#pre-video").onchange = updateEstimate;
$("#prepare-call").onclick = async () => {
  if (page === "chats" && room !== "study") await switchRoom("study");
  $("#call-error").textContent = "";
  $("#call-dialog").showModal();
  updateEstimate();
  try {
    const config = await api("/ice");
    call.config = config;
    $("#relay-notice").textContent = config.relayConfigured
      ? "Relay available for restrictive networks."
      : "No TURN relay configured. Calls may fail on restrictive or mobile networks; see README for setup.";
  } catch (err) {
    $("#call-error").textContent = err.message;
  }
};
$("#close-call-dialog").onclick = () => $("#call-dialog").close();
$("#join-call").onclick = async () => {
  const btn = $("#join-call");
  btn.disabled = true;
  try {
    await call.join($("#pre-quality").value, $("#pre-video").checked);
    $("#call-dialog").close();
  } catch (err) {
    $("#call-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};
$("#leave-call").onclick = () => call.leave();
$("#toggle-mic").onclick = () => call.toggleMic();
$("#toggle-video").onclick = () => call.toggleVideo();
$("#live-quality").onchange = (e) => {
  const q = e.target.value;
  if (
    qualities[q].bitrate > qualities[call.quality].bitrate &&
    !confirm(
      `Raise call quality? Video may use about ${estimate(q, true)} MB per 10 minutes per other person.`,
    )
  ) {
    e.target.value = call.quality;
    return;
  }
  call.setQuality(q);
};
async function quiz() {
  const form = $("#quiz-form");
  if (form.children.length) return;
  try {
    const questions = await api("/quiz");
    for (const [i, q] of questions.entries()) {
      const field = el("fieldset");
      field.append(el("legend", "", `${i + 1}. ${q.q}`));
      for (const [j, option] of q.options.entries()) {
        const label = el("label");
        const input = el("input");
        input.type = "radio";
        input.name = "q" + i;
        input.value = j;
        input.required = true;
        label.append(input, document.createTextNode(option));
        field.append(label);
      }
      form.append(field);
    }
    const submit = el("button", "primary", "Check my answers ↗");
    form.append(submit);
    form.onsubmit = async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const f = new FormData(form);
        const result = await api("/quiz", {
          answers: questions.map((_, i) => Number(f.get("q" + i))),
        });
        $("#quiz-result").textContent =
          `You got ${result.score} out of ${result.total}. Your best score is saved on the learning board.`;
      } catch (err) {
        toast(err.message);
      } finally {
        submit.disabled = false;
      }
    };
  } catch (err) {
    toast("Connect to load the quiz.");
  }
}
async function leaders() {
  const box = $("#leaders");
  box.replaceChildren();
  try {
    const people = await api("/leaderboard");
    if (!people.length)
      box.append(
        el("p", "muted", "Your name could be first. Try the quick quiz."),
      );
    people.forEach((p, i) => {
      const row = el("div", "leader-row");
      row.append(
        el("span", "", String(i + 1).padStart(2, "0")),
        el("strong", "", p.name + " · " + p.level),
        el("span", "", p.score + " / 3"),
      );
      box.append(row);
    });
  } catch {
    box.append(el("p", "muted", "Connect to load the learning board."));
  }
}
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {});
window.addEventListener("beforeunload", () => {
  call.leave();
  for (const url of objectUrls) URL.revokeObjectURL(url);
});
try {
  user = await api("/me");
  await stored("user", user);
} catch (err) {
  if (!err.status) user = await stored("user");
  else if (err.status === 401) {
    await clearStored();
  }
}
if (user) await enter();
