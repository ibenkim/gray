# Interaction recording (telemetry)

Privacy-conscious recording of the user’s **other desktop apps** while “Record a workflow” is active. Capture runs in the Electron **main process** (not a page keylogger): frontmost-app polling via `active-win`, optional macOS Accessibility via a long-lived JXA/`osascript` process, clipboard change detection (hashes only), sparse local keyframe JPEGs, and a small set of global shortcut chords (never Cmd+C/V/X).

## How recording works

1. User starts recording explicitly (`Start Recording`, ⌥R, or the pill context menu).
2. Main process creates a telemetry session, starts polling the frontmost window, starts the JXA Accessibility sampler (if enabled), starts the clipboard watcher, and queues sanitized events.
3. The Learning ledger streams short, redacted lines over IPC.
4. **Finish** flushes the queue, stops the session, runs the deterministic polisher + variable extractor, then makes **one** OpenAI Responses API call (Structured Outputs) to extract a workflow.
5. **Cancel** stops and discards without polish/LLM.

Recording cannot be started twice; a second `telemetryStart` is a no-op while a session is active.

## Start / stop

| Action | UI | IPC |
|---|---|---|
| Start | Record panel → **Start Recording** | `telemetry:sessionStart` |
| Finish | Learning ledger → **Finish** | `telemetry:sessionStop` (polish + LLM) |
| Cancel | Learning ledger → **Cancel** | `telemetry:sessionStop` with `{ discard: true }` |

Requires Screen Recording permission (onboarding gate). Accessibility is an **optional** onboarding card for richer focus/selection/field evidence. Microphone remains deferred.

## Development file storage

With `TELEMETRY_STORAGE=file` (dev only):

```text
development-data/telemetry/
  normalized/<sessionId>.jsonl   # append-only sanitized events
  polished/<sessionId>.json      # deterministic polished actions
  workflows/<sessionId>.json     # validated OpenAI extraction
  variables/<sessionId>.json     # deterministic workflow variables
  keyframes/<sessionId>/*.jpg    # sparse local keyframes (not uploaded)
  meta/<sessionId>.json          # session status metadata
```

- Config: `TELEMETRY_DEV_DIR` (default `./development-data/telemetry`).
- In development, `TELEMETRY_STORAGE` defaults to `file` even when unset (fresh clone works without `.env`).
- `development-data/` is gitignored — never commit recorded sessions.
- Only the **main process** writes these files. The renderer never touches the filesystem.
- `FileTelemetryStore` **refuses to initialize when the app is packaged**. Do not use local files in production or serverless deployments.

### Inspecting JSONL

```bash
# Pretty-print the last few events of a session
tail -n 5 development-data/telemetry/normalized/<sessionId>.jsonl | jq .
```

Each line is an envelope: `{ schemaVersion, receivedAt, event }`.

### Clearing local telemetry

```bash
rm -rf development-data/telemetry
```

Directories are recreated on the next recording (or app start when the store initializes).

## Privacy rules

- Typed text **is** recorded (a workflow cannot be replayed without it), but only after redaction, and never from a secure/password field. See "Typing capture" below.
- Never records passwords, tokens, cookies, raw clipboard contents, or secret fields.
- Clipboard events store only `contentType`, URL host/path, char count, and a content hash. Raw values stay in-memory for the session (for variable promotion) and are dropped on stop.
- Field values are redacted by default; only semantic info (label, type, completed, category, optional length) is kept.
- Explicit allowlist in `src/shared/telemetry/sanitize.ts` (`VALUE_ALLOWLIST`) for fields whose sanitized values may be stored.
- Data is sanitized at capture and again on ingest/polish.
- No pointer/hover streams and no continuous screen video. Sparse keyframes (active window, ≤1/s, JPEG ~70%) are stored as relative paths only and are **not** uploaded to OpenAI in this phase.
- Events originating from Ghost's own windows are dropped before they are recorded, so typing into the app itself is never captured.

### Typing capture

Key presses are observed passively through `NSEvent` global monitors in the JXA
sensor and aggregated host-side into one `text_input` event per entry. An entry is
flushed on Return/Tab/Escape, on a modifier chord, when focus moves to another
element, after 1.2s of inactivity, or when the session stops.

Guards, in order:

1. Characters are never read while macOS **secure input** is active (`IsSecureEventInputEnabled`) or while the focused element is an `AXSecureTextField`.
2. `sanitizeTypedText` redacts emails, vendor-prefixed credentials (`sk-…`, `ghp_…`, `xox…`), high-entropy strings ≥24 chars, and digit runs ≥9 digits.
3. `redactEvent` re-applies the same redaction on ingest, and drops `typedText` outright when the target element looks sensitive (label matches `password|token|secret|…`).
4. `shouldDropEvent` discards a `text_input` that redacted down to nothing.

Only `keyCount` (how many physical presses) survives redaction, never the keys themselves.

### Click capture

Mouse presses come from the same monitors. The element under the pointer is
resolved with `AXUIElementCopyElementAtPosition`, giving a `click` event with the
control's role, label, and up to three ancestor labels. Chords (including Cmd+C/V/X)
are observed rather than intercepted, so the recorded app still receives them —
the previous `globalShortcut` accelerators are now only a fallback for when
Accessibility is unavailable.

> **The Accessibility permission is what makes all of the above work.** Without it
> the sensor still runs but reports `{"k":"ready","trusted":false}` and a recording
> degrades to app switches, clipboard changes, and fallback shortcuts only.

### Marking private / ignored UI (future DOM / AX providers)

When an interaction provider is enabled:

- `data-telemetry-ignore` — skip the element entirely.
- `data-private` — redact contents; treat as sensitive.
- `data-analytics-id` — stable semantic id for targeting (preferred over CSS selectors).

Sensitive names (`password`, `token`, `secret`, `email`, `phone`, `card`, …) are treated as sensitive by default.

## Environment

See `.env.example`. The main process loads `.env` via `dotenv` at startup.

```text
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.6-luna
TELEMETRY_STORAGE=file
TELEMETRY_DEV_DIR=./development-data/telemetry
```

On launch you should see logs like:

```text
[telemetry] ready — storage=file dir=/…/development-data/telemetry openai=configured
[telemetry] interaction capture — accessibility=granted
```

If the second line says `accessibility=DENIED`, clicks and typing will not be
captured and automated playback cannot start.

### JXA gotcha

Both JXA children (`jxaScript.ts` sensor and `jxaActuatorScript.ts` actuator) speak
NDJSON over **stdout**, written via `NSFileHandle.fileHandleWithStandardOutput`.
Never use `console.log` in those scripts: under `osascript -l JavaScript` it writes
to **stderr**, which the host does not read — every message would be silently lost.

**Restart required:** after editing `.env` (including `OPENAI_API_KEY`), quit and relaunch the Electron main process. Env is loaded once at startup.

You do **not** need `OPENAI_API_KEY` to collect data. Without it (or with an invalid key), **Finish** still writes `normalized/` + `polished/`. Session meta keeps `captureStatus: "stopped"` and sets `processingStatus: "failed"` with a safe code such as `OPENAI_AUTHENTICATION_FAILED` — never the raw OpenAI message. Use the toast **Retry** (or `telemetry:processWorkflow`) after fixing the key.

`OPENAI_API_KEY` stays in the main process only (never renderer / preload / `VITE_*`). OpenAI is called **once per completed processing attempt**, not per event. Invalid model output is rejected and not stored.

## Architecture map

| Piece | Location |
|---|---|
| Shared schema (Zod) | `src/shared/telemetry/schema.ts` |
| Sanitization | `src/shared/telemetry/sanitize.ts` |
| Capture + shortcuts | `src/main/telemetry/capture.ts` |
| Input/AX host adapter | `src/main/telemetry/ax/JxaAccessibilityProvider.ts` |
| JXA sensor script | `src/main/telemetry/ax/jxaScript.ts` |
| Clipboard watcher | `src/main/telemetry/clipboard.ts` |
| Sparse keyframes | `src/main/telemetry/keyframes.ts` |
| Variables | `src/main/telemetry/variables.ts` |
| Batch queue | `src/main/telemetry/queue.ts` |
| File store | `src/main/telemetry/store/FileTelemetryStore.ts` |
| Polisher | `src/main/telemetry/polish.ts` |
| Model input (compact) | `src/main/telemetry/modelInput.ts` |
| Prompt | `src/main/telemetry/prompt.ts` |
| Workflow LLM | `src/main/telemetry/workflow.ts` |
| IPC | `src/main/telemetry/index.ts` |

IPC channels mirror the intended HTTP shapes:

- `telemetry:sessionStart` ↔ `POST /api/telemetry/sessions/start`
- `telemetry:events` ↔ `POST /api/telemetry/events`
- `telemetry:sessionStop` ↔ `POST /api/telemetry/sessions/:sessionId/stop`
- `telemetry:getWorkflow` ↔ `GET /api/telemetry/sessions/:sessionId/workflow`

## Tests

```bash
npm test
npm run typecheck
```

Coverage includes model-input sanitization, clipboard hashing, polish copy→paste→send merges, variable extraction, safe OpenAI error codes, evidence validation, and retry-without-re-record (mocked OpenAI client).

## Remaining production work

- Implement a production `TelemetryStore` adapter (DB / remote API). Do **not** fall back to `TELEMETRY_STORAGE=file` when packaged.
- Replace JXA polling with a native `AXObserver` provider for event-driven Accessibility.
- Selective vision upload of 5–15 useful keyframes for ambiguous segments.