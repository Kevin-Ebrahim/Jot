# Jot

Jot is a local-first Markdown notebook with optional self-hosted accounts, sync, sharing, and comments. It works without an external account provider or hosted backend service.

## Run locally

Requires Node.js 24 or newer and npm.

```sh
npm ci
npm run dev
```

The project `.npmrc` skips an unused Node/CUDA runtime download for browser-only inference. If a strict npm version rejects that third-party setting, remove its line and run `ONNXRUNTIME_NODE_INSTALL=skip npm ci`; browser WASM is unaffected.

Open `http://localhost:3000`. This is the default trusted origin. If you use another hostname or port, set `JOT_APP_ORIGIN` to the exact address you will open in the browser; for example:

```sh
JOT_APP_ORIGIN=http://127.0.0.1:3215 npm run dev -- --hostname 127.0.0.1 --port 3215
```

For a production build:

```sh
npm run build
npm start
```

The server stores its SQLite database in `.jot-data` by default. Set `JOT_DATA_DIR` to a private, persistent directory for a deployment. Stop the server before copying that entire directory, or use a SQLite-aware backup. Keep separate backups: browser data can be lost when site storage is cleared.

## Workspaces and collaboration

- Guest notes and attachments live in this browser's IndexedDB. Signing in opens a **separate** account workspace; live guest notes, notebooks, and attachments are copied only when you explicitly choose to copy them.
- The first local account may register by default. To add other accounts, restart the server with `JOT_ALLOW_REGISTRATION=true`, then remove that setting and restart after onboarding; `false` disables all registration. Passwords must be at least 12 characters. Sharing grants access to existing accounts; no invitation email is sent.
- Account notes, notebooks, and attachments sync with this server. While the app is visible and online it polls approximately every 30 seconds; you can also sync manually. Changes made offline are retained locally and retried. Conflicts require a choice and preserve the local draft rather than silently overwriting it.
- Account sync requires browser Web Locks support to prevent cross-tab races. If unavailable, sync is disabled; local editing and export remain available.
- Share a note or notebook as viewer or editor. Notebook access applies to its notes; a separate note share can grant stronger access. Owners manage shares and trash/restore. Editors can change content and comment. This is versioned polling, **not** character-by-character CRDT co-editing.
- Attachments are limited to 10 MiB each. Server content, storage, and record quotas apply, including trashed notes; see [server notes](src/server/README.md).

A production service worker can cache the app shell after a successful first load in a secure context (HTTPS or localhost). In a tested browser, after that cache was established, offline reload and editing worked and account sync resumed automatically after reconnecting. Availability still depends on the browser retaining the installed cache and local storage; features needing the network are unavailable offline.

## Privacy and backups

IndexedDB in the browser is **not encrypted by Jot**. A JSON backup contains the current workspace's notes, notebooks, and live local attachments, up to 150 MiB encoded. It may optionally be password-encrypted; save that password separately because it cannot be recovered. Comments, shares, and account settings are not included; protect those with a server SQLite backup. Markdown ZIP export includes notes, live attachments, and a metadata manifest, not server comments or shares. Imports create new copies rather than overwrite notes; imports into an account workspace are queued for sync.

Server content is plaintext by default. For a **new, empty data directory only**, set `JOT_ENCRYPTION_KEY` to a securely generated 64-character hexadecimal key before the first start. Keep the same key for every restart and back it up separately from the database. Losing it makes encrypted content unreadable; existing plaintext databases are not silently migrated. This optional AES-256-GCM mode encrypts note/notebook content, comment text, and attachment filenames and bytes, but account emails and operational metadata remain visible. The running server can decrypt the content: it is **not end-to-end encryption**. It does not encrypt browser storage or exports automatically. See [server notes](src/server/README.md) for the precise scope and configuration.

For any non-local deployment, use HTTPS and a trusted reverse proxy. Set `JOT_APP_ORIGIN` to the exact public origin (including any non-default port) and `JOT_SECURE_COOKIES=true` when TLS terminates at the proxy. Jot does not trust forwarded host headers to determine its CSRF origin. Restrict registration and add proxy-level rate limits. Never commit keys, passwords, or database files.

## Capture and organization

Markdown notes support tags, links, checklists, search, templates, and local rediscovery. A web capture saves an HTTP(S) bookmark and optional pasted/imported content; it does not fetch the remote page. PDF capture extracts selectable text locally, not scanned pages. Image OCR is opt-in and English-only; on first use it loads pinned engine and language files from this app's origin, and the image is processed locally. A tested browser recognized and searched an image online and, after those assets were cached, offline. Results vary and offline use depends on retained assets.

Prerecorded audio transcription is opt-in, English-only, and limited to two minutes and 10 MiB. It is designed to run locally in the browser using `Xenova/whisper-tiny.en`; first use downloads about 45 MB of model files from Hugging Face plus runtime from this app's origin. Audio is not sent to a transcription service, but normal account sync may send saved audio and transcripts to your server. Review results for mistakes; browser inference is still awaiting verification. Recording and live dictation depend on browser support, and a browser speech provider may receive dictated audio.

Reminders appear in the Tasks view; Jot does not send background alerts. Recurring notes are manual by default. An optional per-routine setting creates one due occurrence while Jot is open and foregrounded, then advances to the next future date; missed occurrences are not backfilled. There is no closed-app or server scheduler.

## Checks

```sh
npm run typecheck
npm test
npm run build
# Production offline browser check; requires a working Playwright browser:
npm run test:offline
# Disposable production HTTP and client-adapter checks (after build):
node tests/backend-live.mjs
node --import tsx tests/backend-client-live.mts
```

The client-adapter check uses fake IndexedDB in Node, not a browser. The HTTP smoke tests use disposable databases and synthetic accounts.
