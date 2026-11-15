import { test } from "node:test";
import assert from "node:assert/strict";
import { StudyCall, estimate } from "../public/call.js";
test("congestion lowers video caps, recovery respects chosen ceiling and low-data ceiling", async () => {
  const nodes = new Map();
  globalThis.document = {
    querySelector: (key) => {
      if (!nodes.has(key)) nodes.set(key, {});
      return nodes.get(key);
    },
  };
  let low = false,
    bad = true,
    timestamp = 0,
    bytes = 0;
  const applied = [];
  const sender = {
    track: { kind: "video" },
    getParameters: () => ({ encodings: [{}] }),
    setParameters: async (p) => applied.push(p.encodings[0].maxBitrate),
  };
  const call = new StudyCall({
    send: () => {},
    lowData: () => low,
    notify: () => {},
  });
  call.active = true;
  call.quality = "medium";
  const peer = {
    current: 350000,
    healthy: 0,
    last: new Map(),
    pc: {
      getSenders: () => [sender],
      getStats: async () =>
        new Map([
          ["loss", { type: "remote-inbound-rtp", fractionLost: bad ? 0.2 : 0 }],
          [
            "sent",
            {
              id: "sent",
              type: "outbound-rtp",
              timestamp: (timestamp += 3000),
              bytesSent: (bytes += 12000),
            },
          ],
        ]),
    },
  };
  call.peers.set("one", peer);
  await call.adapt();
  assert.equal(peer.current, 245000);
  assert.equal(applied.at(-1), 245000);
  bad = false;
  for (let i = 0; i < 40; i++) await call.adapt();
  assert.equal(peer.current, 350000);
  low = true;
  await call.adapt();
  assert.equal(applied.at(-1), 120000);
  assert.match(nodes.get("#call-bitrate").textContent, /32 kbps/);
  assert.ok(estimate("high", true) > estimate("medium", true));
  assert.ok(estimate("medium", true) > estimate("low", true));
  assert.ok(estimate("low", true) > estimate("low", false));
});
