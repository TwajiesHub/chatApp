# StudyLight

A lightweight learning hub for Nigerian secondary-school students. Plain browser JavaScript, CSS, a small Express/WebSocket server, and SQLite. No frontend framework, CDN fonts, analytics, or build step. The working first slice is **account → shared study chat → synchronised focus timer → WebRTC call**.

## Run

Requires **Node.js 22.13+** (Node 24 LTS recommended) and npm. SQLite uses Node’s built-in `node:sqlite` module; older Node versions will not work.

```sh
npm ci
npm start
```

Open `http://localhost:3000`. Create two accounts in separate browsers or browser profiles, then join the study room from both. Use a real second device over **HTTPS** to test physical cameras. An ordinary HTTP LAN address cannot access camera/microphone APIs. Keep the server running for signaling, chat and API requests.

```sh
npm run dev           # restart server when source changes
npm run check         # JavaScript syntax checks
npm test              # isolated API, WebSocket, persistence and adaptation tests
npm run test:browser  # two real browser sessions + mobile layout
```

Browser tests use `/usr/bin/chromium` by default; set `CHROMIUM_PATH` to your browser executable. Alternatively run `npx playwright install chromium` and set `CHROMIUM_PATH` to the installed Chromium executable. Fake camera/microphone inputs are used in tests, but the peer connections and media transport are real. Browser tests start a separate server on port 3100 with a temporary SQLite directory. They exercise account creation, two-way chat, timer sync, video reception, quality controls, voice-only switching, file download, offline reload, queued text delivery, private chat, and quiz scoring. Direct UDP must be available **or** the test server must receive the TURN settings below. Managed cloud browsers often disable direct UDP; a missing relay causes the media test to fail, rather than silently passing a signaling-only check.

## What is included

- Username/password accounts and profiles: name, JSS1–SS3 class, optional school. Passwords use salted scrypt; sessions are opaque HttpOnly cookies and expire after seven days.
- A shared study circle; persistent private 1:1 and small-group chat (up to six members). Choose classmates from **Messages → New conversation**. Membership is enforced on both API and signaling routes.
- A shared 25-minute focus timer, persisted on the server and synced over WebSockets. Any study-room member can start/end it for everyone.
- Study-room audio/video calls for up to **four people**. Explicit camera and mic controls, pre-call estimates, live quality selection, total measured media bitrate and adaptive per-peer send limits.
- Compressed images, PDF attachments and compressed voice notes (60 seconds maximum). Resources download only when tapped, and are saved for offline use.
- A three-question warm-up and leaderboard of each student's best score. Quiz answers and scoring stay on the server.
- Installable PWA shell, latest 80 messages per opened conversation, saved resources and an offline text outbox. No automatic video/image downloads.

## Low-data behaviour

Low-data mode defaults **on**, remembers your choice on this device, and caps video at Low. Turn it off to unlock Medium and High. Increasing live quality or re-enabling the camera displays a data warning. These are limits on **each outgoing peer connection**, not a promise about the other participants' settings.

| Quality    | Camera target        | Video send ceiling per peer      | Approx. 10-minute two-way budget per other person |
| ---------- | -------------------- | -------------------------------- | ------------------------------------------------- |
| Low        | 320 × 180, 10 fps    | 120 kbps                         | 28 MB                                             |
| Medium     | 640 × 360, 15 fps    | 350 kbps                         | 69 MB                                             |
| High       | 1280 × 720, 24 fps   | 900 kbps                         | 168 MB                                            |
| Voice only | Camera track stopped | Audio encoding capped at 24 kbps | 6 MB                                              |

Estimates budget 32 kbps for audio each way and 20% transport overhead. They assume both sides use the selected quality; real usage depends on the other people, loss/retransmissions, browser codecs, silence and TURN transport. A four-person mesh can cost about **three times** the table's per-person budget. The live bitrate sums RTP audio/video bytes across all peer connections; it excludes some network overhead and is not a carrier billing meter. No naira estimate is shown because tariffs vary.

Every three seconds, `getStats()` checks reported packet loss, RTT, outgoing capacity and bandwidth limitation. Congestion reduces video ceilings by 30%, down to 40 kbps; five healthy samples permit a gradual recovery up to the selected quality ceiling. `RTCRtpSender.setParameters()` applies bitrate and frame-rate limits; actual encoder behaviour depends on the browser. Audio is kept separate from video. **Voice only stops the camera and removes its outgoing track**, retaining audio and the existing connection. The camera can be re-enabled without leaving.

Images are resized locally (long edge 1,000px at WebP quality 0.55 in low-data mode; otherwise 1,600px / 0.72). Voice notes request mono Opus at 16 kbps on supported browsers, with a supported MP4 recording fallback. Browser encoders may vary. A one-minute 16 kbps note is roughly 120 KB. Files must be under **2 MB after compression**; PDFs are not recompressed. Uploads and downloads over 250 KB ask before using data. Text is capped at 2,000 characters. HTTP compression is enabled; there is no polling loop for messages.

## Offline and shared devices

The service worker caches only the application shell. IndexedDB stores the active profile, recent chat snapshots, explicitly downloaded blobs (30 MB application limit) and up to 100 queued text messages. Offline sends get a visible **Waiting to send** status. Reconnection uses stable client IDs to prevent duplicate delivery. Attachments need a live connection; failed uploads remain in the composer for a manual retry. Quizzes, leaderboard, sign-in, timer changes and calls need a connection.

Visit each conversation and download resources before going offline. Browser storage can be evicted, so offline copies are not backups. Offline data is unencrypted local device storage: sign out on a shared device. **Sign out clears this app’s IndexedDB**, ends the current server session and closes that account's open signaling sockets. Signing out requires connectivity so the session can be revoked. Offline access on a previously signed-in device does not establish a new server session.

## WebRTC and TURN

The MVP uses native browser WebRTC with a mesh of at most four participants and a same-origin WebSocket signaling server. This keeps the server lightweight and gives direct access to bandwidth controls. A public Google STUN server is configured as the default; STUN alone is not sufficient for many mobile/carrier NAT or restrictive networks.

For reliable calls between networks, use **coturn** (open source) or a managed TURN provider. Configure the application server using its environment, not source code:

```sh
TURN_URL='turns:turn.example.org:5349?transport=tcp' \
TURN_USERNAME='<provided username>' \
TURN_PASSWORD='<provided password>' \
SECURE_COOKIE=1 npm start
```

Replace the placeholders with your provider's real settings. `turn:host:3478?transport=udp` or TCP are also supported. A TLS/TCP endpoint (commonly port 443) is important for restrictive connections. The app warns when no TURN binding is configured. `/api/ice` returns the configuration only to authenticated accounts. Static TURN credentials are suitable for a controlled pilot; before a public launch, use expiring per-user TURN credentials or a provider token endpoint and quotas. Do not put relay credentials in the browser bundle or commit them. A media relay needs network access to both clients; HTTPS proxy placeholders cannot replace credentials inside WebRTC's TURN protocol.

Production coturn should use authentication, TLS, correct public/relay addresses and configured UDP relay ports, with private/loopback destination blocking and resource quotas. Do not expose an unauthenticated relay. Use an SFU such as LiveKit for larger rooms: a mesh's uplink cost grows with each participant. That is intentionally outside this four-person slice.

### Validation in this cloud environment

The browser's managed policy disables non-proxied UDP. Two-browser media was verified using an authenticated **loopback-only coturn TCP relay**, with disposable test credentials, rather than altering the browser policy. The end-to-end test checked a received remote video track, not just an open socket. That local relay is a test fixture, not a production TURN service or proof of Nigerian carrier connectivity. Real devices, limited mobile plans, and a deployed TLS relay still need field testing.

## Configuration and deployment

| Variable                                     | Default                                        | Purpose                                                                  |
| -------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `PORT`                                       | `3000`                                         | HTTP / WebSocket port                                                    |
| `DATA_DIR`                                   | `./data`                                       | Persistent SQLite directory; writable by the app                         |
| `ALLOWED_ORIGINS`                            | Current Render URL + HTTP loopback on any port | Comma-separated trusted HTTP(S) origins; when set, replaces defaults     |
| `SECURE_COOKIE`                              | unset                                          | Set `1` behind production HTTPS to require secure cookies                |
| `TURN_URL`, `TURN_USERNAME`, `TURN_PASSWORD` | unset                                          | Optional TURN binding; required for reliable restrictive-network calling |

Use one Node process and persist `DATA_DIR` on durable storage. The database holds users, sessions, chat, binary attachments, timer and scores. Back it up using SQLite's supported backup facilities; do not copy a live database without its WAL. Place a TLS reverse proxy in front and forward WebSocket upgrades. The proxy should preserve the external Host and strip untrusted forwarded headers. The application checks mutation and WebSocket origins. HTTP API mutations, CORS preflights and WebSocket upgrades share the same origin allowlist, independently of `SECURE_COOKIE` and the internal proxy protocol. By default it accepts `https://studylight-gg38.onrender.com` and HTTP `localhost`, `127.0.0.1` and `[::1]` on any port. Render's `RENDER_EXTERNAL_URL`, when present, also adds the exact URL of this service to the defaults, accommodating a future service hostname without trusting every `*.onrender.com` site.

To override the defaults, set a comma-separated list in Render's environment settings (then redeploy):

```sh
ALLOWED_ORIGINS='http://localhost:3000,http://localhost:3100,https://studylight-gg38.onrender.com'
```

Include every origin you need when overriding: the configured list replaces all defaults, including local development and `RENDER_EXTERNAL_URL`. Use scheme + hostname + optional port; a trailing slash is accepted, but paths, wildcard domains, `null` and malformed origins are rejected. An empty list denies all browser origins. Origins are not inferred from untrusted Host or forwarded headers. Allowed origins receive credentialed CORS headers; other origins cannot mutate state or open authenticated WebSockets. Requests without an Origin header retain the existing CLI/native-client behaviour. The browser app still uses same-origin API requests and SameSite=Strict cookies; this does not turn cross-site cookie sessions into a supported deployment topology. Do not open this pilot publicly without deployment hardening.

## Deliberate MVP limits

No password recovery, profile editing, moderation/reporting, school verification, push notifications, read receipts, message search, encryption at rest or end-to-end encrypted chat. The open study circle is visible to every registered student; private conversations are membership-controlled. Classroom rosters are visible to signed-in users. Resource retention and total server storage quotas, robust abuse controls and safeguarding workflows must be added before a real school rollout. A basic per-IP auth limiter is included, but this is a single-instance pilot, not a hardened public service. Session cleanup and data-retention policies are not automated.

Calls are available in the shared study room; direct/group conversations currently provide text and attachments. Peer media is encrypted by WebRTC; chat and stored files are accessible to the server operator. Performance and call quality still depend on device, browser and network. Failed call setup can be retried without losing chat.

## Structure

- `server.js`: SQLite schema, session auth, HTTP API, WebSocket chat updates and room-scoped call signaling.
- `public/app.js`: navigation, chat, outbox, compression, resources, quiz and timer UI.
- `public/call.js`: WebRTC peer lifecycle, media controls, quality caps and stats-based adaptation.
- `public/sw.js`: offline shell caching; API responses are never put in the service-worker cache.
- `test/`: API, persistence, signaling, adaptation and browser regression checks.
