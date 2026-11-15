import { test } from "node:test";
import assert from "node:assert/strict";
import { createOriginPolicy } from "../origins.js";
test("defaults allow Render HTTPS behind HTTP proxies and loopback on any dev port", () => {
  const allowed = createOriginPolicy({
    RENDER_EXTERNAL_URL: "https://studylight-new.onrender.com/",
  });
  for (const origin of [
    "https://studylight-gg38.onrender.com",
    "https://studylight-new.onrender.com",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3100",
    "http://[::1]:4000",
  ])
    assert.equal(allowed(origin), true, origin);
  for (const origin of [
    "https://evil.onrender.com",
    "https://studylight-gg38.onrender.com.evil.test",
    "http://localhost.evil.test:3000",
    "null",
    "https://evil.test",
    "https://user:pass@studylight-gg38.onrender.com",
    "https://studylight-gg38.onrender.com/path",
  ])
    assert.equal(allowed(origin), false, origin);
});
test("explicit configuration replaces defaults and rejects invalid configuration", () => {
  const allowed = createOriginPolicy({
    ALLOWED_ORIGINS: " https://school.example/ , http://localhost:4567 ",
    RENDER_EXTERNAL_URL: "https://ignored.onrender.com",
  });
  assert.equal(allowed("https://school.example"), true);
  assert.equal(allowed("http://localhost:4567"), true);
  for (const origin of [
    "http://localhost:3000",
    "https://studylight-gg38.onrender.com",
    "https://ignored.onrender.com",
  ])
    assert.equal(allowed(origin), false);
  assert.equal(
    createOriginPolicy({ ALLOWED_ORIGINS: "" })("http://localhost:3000"),
    false,
  );
  for (const value of [
    "*",
    "null",
    "https://school.example/path",
    "ftp://school.example",
    "https://*.onrender.com",
  ])
    assert.throws(() => createOriginPolicy({ ALLOWED_ORIGINS: value }));
});
