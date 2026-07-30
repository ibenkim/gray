# Ghost

A transparent, always-on-top floating workflow recorder that lives in the bottom-right corner of your screen. Hover the bubble to configure a recording, capture a workflow across apps, review and edit the learned steps, then run it back.

> Workflow **recording capture** uses a privacy-conscious desktop telemetry pipeline (`active-win` + Accessibility focus/selection + clipboard hashing + sparse local keyframes → sanitized JSONL → polish → one OpenAI extraction). Agent **execution** remains stubbed. See [docs/telemetry.md](docs/telemetry.md).

## Prerequisites

| Requirement | Notes |
|---|---|
| **macOS** | Primary platform (Screen Recording TCC, tray, vibrancy). Other OSes may launch but permissions short-circuit. |
| **Node.js 18+** | Includes npm. |
| **OpenAI API key** | Optional for recording. Required only when you **Finish** a session and want workflow extraction. |

## Quick start

```bash
# 1. Clone and install
git clone <repo-url> gray
cd gray
npm install

# 2. (Optional) Configure OpenAI for Finish → workflow extraction
cp .env.example .env
# Edit .env and set OPENAI_API_KEY=sk-...

# 3. Run in development
npm run dev
```

> If you develop inside an Electron-based editor terminal (e.g. Cursor/VS Code), it may export `ELECTRON_RUN_AS_NODE=1`, which makes the dev launch crash with `Cannot read properties of undefined (reading 'isPackaged')`. Run with it cleared:
>
> ```bash
> env -u ELECTRON_RUN_AS_NODE npm run dev
> ```

### Useful scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start Electron + Vite in development |
| `npm test` | Run unit tests (Vitest) |
| `npm run typecheck` | TypeScript project build check |
| `npm run build` | Compile main / preload / renderer to `out/` |

## Permissions and privacy

Onboarding asks for **Screen Recording** (required) and optionally **Accessibility** (richer click/focus/selection capture). Recording still works with Screen Recording alone — Accessibility just produces thicker evidence.

While recording, Ghost captures:

- Frontmost app / window / document title (and URL host/path when available)
- Focused controls, selected list rows, and field length changes (when Accessibility is granted)
- Clipboard **metadata** only (content type, URL host/path, hash) — never the raw value in JSONL
- Sparse local JPEG keyframes on meaningful events (app change, activation, clipboard, settle) — paths only, not uploaded
- Named shortcut chords (e.g. Cmd+S) — **not** individual keystrokes and not Cmd+C/V/X

Data is sanitized at capture and stored locally under `development-data/telemetry/` (gitignored). The **only network call** is one OpenAI Responses API request when you **Finish** a recording (if `OPENAI_API_KEY` is set). Cancel discards without calling OpenAI. Keyframes are never sent to OpenAI in this phase.

See [docs/telemetry.md](docs/telemetry.md) for the full pipeline and privacy rules.

## Environment

Copy `.env.example` → `.env`. Variables are loaded once at Electron main-process startup — restart after edits.

| Variable | Default (dev) | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | _(empty)_ | Workflow extraction on Finish |
| `OPENAI_MODEL` | `gpt-5.6` | Model for Structured Outputs |
| `TELEMETRY_STORAGE` | `file` | Local JSONL store in development |
| `TELEMETRY_DEV_DIR` | `./development-data/telemetry` | Where sessions are written |

Without a key, recording and local polish still work; Finish fails with a safe retryable error until you add a key and restart.

## Troubleshooting

### Gatekeeper / “malware” on `active-win`

`active-win` ships an unsigned native binary. After `npm install`, macOS may quarantine it and report that the app or module “cannot be verified free of malware.” Clear quarantine on the package:

```bash
xattr -dr com.apple.quarantine node_modules/active-win
```

Dev builds are **unsigned**. Code signing and notarization are a future packaging task — this repo is intended to be run from source via `npm run dev`.

### Electron won’t start from Cursor / VS Code

Clear `ELECTRON_RUN_AS_NODE` as shown in Quick start.

### Recording writes nothing

In development, telemetry defaults to file storage even without a `.env`. Confirm `development-data/telemetry/` appears after a recording, and that Screen Recording is granted for Terminal/Electron in System Settings → Privacy & Security.

## State machine

Ghost is an explicit state machine. Each state resizes the floating window and renders a different panel:

```
idle → hover → recording → organizing → editor → running → summary
```

| State | UI |
|---|---|
| `idle` | Purple floating bubble |
| `hover` | "Record a workflow" panel (One app / Full screen + narrate) |
| `recording` | Bubble with elapsed timer; expandable Learning ledger |
| `organizing` | Transient "Organizing…" chip |
| `editor` | "Here's what I learned" — editable step list, fix-step prompts |
| `running` | Live step runner with pause / resume / skip / stop |
| `summary` | "Here's what I've done" — stopped or done variants |

## Project structure

```
gray/
├── docs/
│   └── telemetry.md           # Recording pipeline + privacy rules
├── src/
│   ├── main/
│   │   ├── index.ts           # Transparent BrowserWindow, tray, IPC
│   │   ├── permissions.ts     # Screen Recording (and future AX / mic helpers)
│   │   ├── auth.ts            # Mocked sign-in (no real OAuth yet)
│   │   └── telemetry/         # Capture → sanitize → polish → OpenAI
│   ├── preload/
│   │   └── index.ts           # IPC bridge as window.ghostBridge
│   ├── renderer/
│   │   └── src/
│   │       ├── App.tsx
│   │       ├── onboarding/    # Welcome → team → Screen Recording
│   │       ├── workspace/     # Library / manage / activity
│   │       ├── state/         # WorkflowContext state machine
│   │       └── components/    # Pill, panels, shared UI
│   └── shared/
│       ├── types.ts
│       └── telemetry/         # Schema + sanitize (shared with main)
├── .env.example
├── electron.vite.config.ts
├── package.json
└── vitest.config.ts
```

## How it works

1. **Main process** (`src/main/index.ts`) opens a `frameless`, `transparent`, `alwaysOnTop` window pinned to the bottom-right of the primary display, plus a system tray icon.
2. `WorkflowContext` drives the state machine. On each state change it calls `window.ghostBridge.setBounds(w, h)`, and the main process resizes the window while keeping it anchored bottom-right.
3. **Recording**: `Start Recording` starts main-process telemetry (`src/main/telemetry/`). Sanitized events stream into the Learning ledger; **Finish** polishes the session and extracts a workflow via one OpenAI Responses call. Dev sessions land under `development-data/telemetry/` (gitignored).
4. The running state still advances steps on a mock interval until agent execution lands.

## Deferred (later phase)

- Native Accessibility interaction provider (clicks / fields / forms)
- Agent execution that performs learned steps
- Production telemetry storage (file adapter is dev-only)
- Packaging, code signing, and notarization
