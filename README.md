# Jot

Jot is a local-first Markdown notebook with optional self-hosted accounts, sync, sharing, and comments. It works without an external account provider or hosted backend service.

## Run locally

Requires Node.js 24 or newer and npm.

```sh
npm ci
npm run dev
```

Open the local address printed by Next.js (normally `http://localhost:3000`). For a production build:

```sh
npm run build
npm start
```

The server stores its SQLite database in `.jot-data` by default. Set `JOT_DATA_DIR` to a private, persistent directory for a deployment. Stop the server before copying that entire directory, or use a SQLite-aware backup. Keep separate backups: browser data can be lost when site storage is cleared.

## Workspaces and collaboration

- Guest notes and attachments live in this browser's IndexedDB. Signing in opens a **separate** account workspace; live guest notes, notebooks, and attachments are copied only when you explicitly choose to copy them.
- The first local account may register by default. To add other accounts, restart the server with `JOT_ALLOW_REGISTRATION=true`, then remove that setting and restart after onboarding; `false` disables all registration. Passwords must be at least 12 characters. Sharing grants access to existing accounts; no invitation email is sent.
- Account notes, notebooks, and attachments sync with this server. While the app is visible and online it polls approximately every 30 seconds; you can also sync manually. Changes made offline are retained locally and retried. Conflicts require a choice and preserve the local draft rather than silently overwriting it.
- Share a note or notebook as viewer or editor. Notebook access applies to its notes; a separate note share can grant stronger access. Owners manage shares and trash/restore. Editors can change content and comment. This is versioned polling, **not** character-by-character CRDT co-editing.
- Attachments are limited to 10 MiB each. Server storage and lifetime attachment-record quotas apply; see [server notes](src/server/README.md).

A production service worker can cache the app shell after a successful first load in a secure context (HTTPS or localhost). Offline availability depends on that installation and browser storage; features needing the network are not available offline. Browser offline reload is still awaiting verification.

## Privacy and backups

IndexedDB in the browser is **not encrypted by Jot**. A full JSON backup includes live attachments and may optionally be password-encrypted; save that password separately because it cannot be recovered. Markdown ZIP export includes notes, live attachments, and a metadata manifest. Imports merge rather than overwrite existing notes.

Server content is plaintext by default. For a **new, empty data directory only**, set `JOT_ENCRYPTION_KEY` to a securely generated 64-character hexadecimal key before the first start. Keep the same key for every restart and back it up separately from the database. Losing it makes encrypted content unreadable; existing plaintext databases are not silently migrated. This optional AES-256-GCM mode encrypts note/notebook content, comment text, and attachment filenames and bytes, but account emails and operational metadata remain visible. The running server can decrypt the content: it is **not end-to-end encryption**. It does not encrypt browser storage or exports automatically. See [server notes](src/server/README.md) for the precise scope and configuration.

For any non-local deployment, use HTTPS and a trusted reverse proxy. Set `JOT_APP_ORIGIN` to the exact public origin and `JOT_SECURE_COOKIES=true` when TLS terminates at the proxy. Restrict registration and add proxy-level rate limits. Never commit keys, passwords, or database files.

## Capture and organization

Markdown notes support tags, links, checklists, search, templates, and local rediscovery. A web capture saves an HTTP(S) bookmark and optional pasted/imported content; it does not fetch the remote page. PDF capture extracts selectable text locally, not scanned pages. Image OCR is opt-in and English-only; on first use it downloads its engine and language files from public CDNs. Existing audio may be attached but is not transcribed. Recording and live dictation depend on browser support; a browser speech provider may receive dictated audio.

Reminders appear in the Tasks view; Jot does not send background alerts. Recurring note occurrences are created manually, not by a background scheduler.

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
