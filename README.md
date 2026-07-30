# Ghost

A transparent, always-on-top floating workflow recorder that lives in the bottom-right corner of your screen. Hover the bubble to configure a recording, capture a workflow across apps, review and edit the learned steps, then run it back.

> Workflow **recording capture** now uses a privacy-conscious desktop telemetry pipeline (`active-win` + shortcut chords → sanitized JSONL → polish → one OpenAI extraction). Element-level Accessibility capture and agent **execution** remain stubbed. See [docs/telemetry.md](docs/telemetry.md).

## Stack

| Layer | Technology |
|---|---|
| Desktop shell | [Electron](https://www.electronjs.org/) |
| UI | React 18 + TypeScript |
| Build | [electron-vite](https://electron-vite.org/) |
| State | React context state machine |

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Run in development
npm run dev

# 3. Build for distribution
npm run build
```

> If you develop inside an Electron-based editor terminal (e.g. Cursor/VS Code), it may export `ELECTRON_RUN_AS_NODE=1`, which makes the dev launch crash with `Cannot read properties of undefined (reading 'isPackaged')`. Run with it cleared: `env -u ELECTRON_RUN_AS_NODE npm run dev`.

## State machine

Ghost is an explicit state machine. Each state resizes the floating window and renders a different panel:

```
idle → hover → recording → organizing → editor → running → summary
```

| State | UI |
|---|---|
| `idle` | Purple floating bubble |
| `hover` | "Record a workflow" panel (One app / Full screen + narrate) |
| `recording` | Bubble with elapsed timer; expandable "Watching {app}" log |
| `organizing` | Transient "Organizing…" chip |
| `editor` | "Here's what I learned" — editable step list, fix-step prompts |
| `running` | Live step runner with pause / resume / skip / stop |
| `summary` | "Here's what I've done" — stopped or done variants |

## Project structure

```
ghost/
├── .planning/                 # Task tracking (todo / in-progress / done)
├── src/
│   ├── main/
│   │   └── index.ts           # Transparent BrowserWindow + window:setBounds IPC
│   ├── preload/
│   │   ├── index.ts           # IPC bridge exposed as window.ghostBridge
│   │   └── index.d.ts
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── env.d.ts
│           ├── state/
│           │   ├── types.ts             # AppState, Workflow, Step, RunStep…
│           │   ├── mockData.ts          # sample apps, watch log, steps, summaries
│           │   └── WorkflowContext.tsx  # state machine + transitions + mock timers
│           ├── components/
│           │   ├── GhostShell.tsx       # routes state → panel
│           │   ├── GhostBubble.tsx      # idle / recording bubble + timer
│           │   ├── ui/                  # SegmentedControl, Toggle, MicIcon
│           │   └── panels/
│           │       ├── RecordPanel.tsx
│           │       ├── WatchingPanel.tsx
│           │       ├── OrganizingChip.tsx
│           │       ├── EditorPanel.tsx
│           │       ├── RunningPanel.tsx
│           │       └── SummaryPanel.tsx
│           └── styles/
│               ├── globals.css          # design tokens + base
│               └── components.css        # panel styles
├── electron.vite.config.ts
├── package.json
└── tsconfig*.json
```

## How it works

1. **Main process** (`src/main/index.ts`) opens a `frameless`, `transparent`, `alwaysOnTop` window pinned to the bottom-right of the primary display.
2. `WorkflowContext` drives the state machine. On each state change it calls `window.ghostBridge.setBounds(w, h)`, and the main process resizes the window while keeping it anchored bottom-right.
3. **Recording**: `Start Recording` starts main-process telemetry (`src/main/telemetry/`). Sanitized events stream into the Learning ledger; **Finish** polishes the session and extracts a workflow via one OpenAI Responses call. Dev sessions land under `development-data/telemetry/` (gitignored). See [docs/telemetry.md](docs/telemetry.md).
4. The running state still advances steps on a mock interval until agent execution lands.

## Deferred (later phase)

- Native Accessibility interaction provider (clicks / fields / forms)
- Agent execution that performs learned steps
- Production telemetry storage (file adapter is dev-only)
- Packaging — see `.planning/TODO.md`

## Task tracking

See the `.planning/` folder: `TODO.md` (backlog), `IN_PROGRESS.md` (active), `DONE.md` (shipped).
