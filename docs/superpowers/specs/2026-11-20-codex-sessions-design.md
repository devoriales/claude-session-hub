# Codex sessions in the hub — design

2026-11-20

## Intent and why

The `/sessions` pane today shows only Claude Code sessions. Alex also runs the
OpenAI Codex CLI (TUI and VS Code extension) on the same machine and wants one
pane that shows **everything**: running and recent sessions from both tools,
with each row saying whether it is a Claude or a Codex session, and working
Jump / Resume for both.

## Goals

- Running Codex sessions appear in the running list: name/title, cwd, repo,
  branch, busy/idle, prompts, tool calls, and a working **Jump**.
- Past Codex sessions appear in **Recent**, **history** (`-a`) and **search**,
  interleaved with Claude ones by recency, with a working **Resume** (opens a
  terminal running `codex resume <id>`).
- Every row (both tools) carries a small tool tag, and `codex` / `claude` are
  searchable words, so `/sessions codex` filters to one tool.
- No Codex on the machine → nothing changes, no errors, no slowdown.

## Non-goals

- PR info for Codex rows beyond what the existing branch→`gh` path already
  gives (it works unchanged once cwd/branch are known).
- In-place resume of a Codex session inside this Claude conversation
  (`/resume` is Claude-only); Codex Resume always opens a new terminal.
- Supporting other agents (Gemini CLI, Cursor agents…). The code should not
  make that harder, but it is not designed for here.
- Codex Cloud tasks; only local sessions.

## Anti-goals

- Guessing at session state so confidently that a dead session shows as
  running, or Jump focuses the wrong window. When unsure, show less.
- Making the 5-second poll noticeably slower on machines with large
  `~/.codex/sessions` trees.

## Constraints

- Codex has no equivalent of `claude agents --json`; `codex agents` is an
  interactive TUI with no JSON output (checked against codex-cli 0.170).
- Codex stores transcripts at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
  (default `CODEX_HOME` is `~/.codex`), a different JSONL schema from Claude's.
- `~/.codex/session_index.jsonl` maps session id → `thread_name` (title) and
  `updated_at`.
- The plugin is a Claude Code hooks module: shell via `$.process.run`, no
  Node APIs, module-level caches reset on reload.
- The plugin ships on a marketplace, so parsing must be defensive across Codex
  versions: unknown schemas degrade to "less info on the row", never to a
  pane error.

## Approaches considered

1. **`lsof` on the sessions tree + transcript parsing (chosen).** A running
   Codex session holds its rollout file open, so
   `lsof +D "$CODEX_HOME/sessions"` returns exactly the live sessions as
   (pid, transcript path) pairs — measured at ~0.1 s. The pid's ancestor chain
   reaches the `codex` TUI on its tty (verified: lsof pid → parent → `codex`
   on ttys001), so the existing `jump.sh` ancestor walk focuses the right
   terminal, and VS Code extension sessions land on its existing
   "focus the VS Code window" path. Recent sessions come from the same
   `find -newest` pattern the Claude history uses, pointed at the Codex tree.
2. **Recent-only, no running section.** Rejected: Alex explicitly wants active
   Codex sessions, and lsof turned out to make them reliably visible.
3. **Talk JSON-RPC to `codex app-server` to list threads.** The "official"
   surface, but marked experimental, needs a protocol client and version
   chasing, and still would not hand us a pid for Jump. Rejected as heavier
   and more fragile than reading files Codex already writes.

Alex picked 1 (running + recent via lsof and transcripts).

## Design

### Discovery of running Codex sessions

- `CODEX_HOME` = `$CODEX_HOME` env var, else `~/.codex`. If
  `$CODEX_HOME/sessions` does not exist, all Codex code paths are skipped.
- Each refresh runs `lsof +D "$CODEX_HOME/sessions"` (machine-parsable form,
  e.g. `-Fpn`, is the builder's choice). Each (pid, path) with a
  `rollout-…-<uuid>.jsonl` path is one running session; the uuid is the
  session id. `lsof` missing or failing → no running Codex rows, no error
  shown (recent rows still work).
- One process may hold several rollout files (the app-server daemon serves
  the TUI and the VS Code extension); every open rollout file is its own row.
- cwd comes from the transcript's `session_meta` line (first line;
  `payload.cwd`). repo/branch come from the existing `gitInfo(cwd)`.
- **Busy/idle:** the transcript's own event log. The tail of the file is
  grepped for the last `task_started` / `task_complete` event: started after
  the last complete → `busy`, else `idle`. If neither is found in the tail,
  fall back to mtime: modified within the last 10 s → `busy`. This is a
  heuristic and may lag a few seconds; acceptable.

### Parsing a Codex transcript (running and recent rows share this)

A Codex sibling of `parseTranscript`, fed by a Codex sibling of the `PEEK`
shell snippet (grep the interesting line shapes, tail-capped, never the whole
file):

- **Prompts:** `response_item` lines with `payload.role === "user"`, text from
  `content[].type === "input_text"`. Skip harness-injected ones: text starting
  with `<` (e.g. `<user_instructions>`, `<environment_context>`) or
  `# AGENTS.md`. Same dedupe/`oneLine` treatment as Claude prompts.
- **Tool calls / actions:** best-effort from the tail:
  `custom_tool_call`-style payloads (tool name + an input field worth
  showing) and command executions (the command string). Unknown shapes are
  skipped silently.
- **Title:** `thread_name` from `$CODEX_HOME/session_index.jsonl`, read once
  per refresh into an id→name map (builder may cache with a TTL). Fallback:
  no title (the row header falls back to the last prompt, as Claude rows do).
- **Automated filter:** keep only sessions whose `session_meta` says
  `thread_source: "user"` (or has no such field, for older versions); this
  drops `codex exec` / subagent-style runs, mirroring the Claude `automated`
  filter.

### Recent / history / search

- The `NEWEST` find runs once per tree: Claude's `projects` (as today, depth
  2) and Codex's `sessions` (depth 4, `rollout-*.jsonl`). Results merge into
  one mtime-sorted list before the existing batch/BATCH pipeline, so Recent
  shows the truly newest sessions of either tool and `-a` shows both full
  histories interleaved.
- Each file's tool is known from which tree it came from; rows carry it.
- Running Codex sessions are excluded from Recent by session id, exactly as
  running Claude ones are.

### Jump and Resume

- `jump.sh` gains a fifth argument `tool` (`claude` | `codex`, default
  `claude`). For `codex`, `open_attached` runs `codex resume <sid>` instead of
  `claude --resume <sid>` / `claude attach`, and the register-side fallback
  copy text does the same.
- Jump for a running Codex row passes the lsof pid; the existing
  tmux/iTerm2/Terminal/VS Code ancestor logic is unchanged and already fits.
- **Running Codex rows never run or copy `codex resume`** (my call): whether
  `codex resume` is safe against a *live* session is unverified, and a wrong
  guess could fork or corrupt the thread. Jump on a running Codex row only
  tries to focus; when it can't, it falls back to copying `cd <cwd>` — no
  `open_attached`, no attach-style copy text. `codex resume` is used only for
  ended sessions (Recent/history rows).
- **Ambiguous pids degrade Jump** (my call): when one lsof pid holds several
  rollout files (a shared daemon serving both the TUI and VS Code), its
  ancestor chain can only lead to one window, so focusing would guess. Each
  file is still its own row, but rows sharing a pid with another row skip the
  focus attempt and go straight to the `cd <cwd>` copy fallback.
- The `kind` carried by a running Codex row is its `session_meta`
  `originator`/`source` mapped to something short (`codex-tui` shows as plain
  interactive, `vscode` shows as `· vscode`); exact mapping is the builder's
  call. jump.sh must never take the `claude attach` branch for `tool=codex`.
- Resume for a Codex Recent row keeps the two-press arming flow but always
  takes the "new terminal" path (never in-place `/resume`); the armed toast
  says it will run `codex resume` there.

### UI

- `SessionInfo` and `RecentInfo` gain `tool: 'claude' | 'codex'`; the snapshot
  shape tag bumps (`snapshot-6`) so stale stored state is discarded.
- Every row shows a short dim tool tag in its header line (e.g. `· claude` /
  `· codex` next to the status/age text) — both tools tagged, per Alex's ask.
  Exact glyphing is the builder's call; it must survive narrow panes
  (truncate-end like its neighbours).
- **Tags appear only while Codex support is active** (my call): when
  `$CODEX_HOME/sessions` is missing or `showCodex` is `false`, no tags are
  drawn at all, keeping the "no Codex on the machine → nothing changes" goal
  true for single-tool users. On Alex's machine (Codex present) every row is
  tagged, per the ask. `showCodex: false` also suppresses the tool-neutral
  empty-state wording.
- The tool name joins the searchable fields on both row kinds.
- The "No other Claude Code sessions running" empty-state line becomes
  tool-neutral when Codex is present on the machine.

### Settings

- New `userConfig` option `showCodex` (boolean, default `true`) in
  `plugin.json`, read like the existing options; `false` restores today's
  Claude-only behaviour. (My call — marketplace users may want it off.)
- README: new short section documenting Codex support, the `showCodex`
  option, and that `lsof` is required for *running* Codex detection.

## Decided during brainstorming

- lsof-based detection over app-server RPC (Alex picked it).
- Busy/idle for Codex is a transcript-derived heuristic, not a real status —
  acceptable so that busy-first sorting keeps working.
- Both tools get a visible tag, not just Codex rows.

## Left to the builder

- Exact lsof invocation/flags and its output parsing.
- The Codex `PEEK` grep patterns and tail sizes; how many bytes of tail make
  the busy/idle grep reliable enough.
- Tag styling and placement details in the pane.
- Whether session_index.jsonl is re-read every refresh or TTL-cached.
- Test coverage: extend `tests/` with fixture-based tests for the Codex
  transcript parser and the busy/idle decision (the existing test setup in
  `tests/search.test.tsx` shows the harness).
