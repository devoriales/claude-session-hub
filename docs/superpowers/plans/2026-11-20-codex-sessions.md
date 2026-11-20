# Codex Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `/sessions` pane also shows running and recent OpenAI Codex CLI sessions, each row tagged `claude` or `codex`, with working Jump and Resume.

**Architecture:** All logic stays in the single hooks module `hooks/register.tsx`, following the existing shape: shell snippets run via `$.process.run` with a name argument (which tests mock by name), parsed into the same `TranscriptInfo`/`SessionInfo`/`RecentInfo` rows. Running Codex sessions come from `lsof` on `$CODEX_HOME/sessions`; recent ones from the same find-newest pattern pointed at the Codex tree, merged by mtime.

**Tech Stack:** TypeScript hooks module (`claude-code` engine API, no Node APIs), POSIX `sh` snippets (macOS + Linux), `claude plugin test` harness.

**Spec:** `docs/superpowers/specs/2026-11-20-codex-sessions-design.md`

## Global Constraints

- No Node APIs; only the `$` engine interface and `$.process.run` shell snippets. Single-file module (`hooks/register.tsx`).
- Shell snippets must be POSIX sh and work on macOS and Linux (see the existing `NEWEST` snippet's `stat -f` / `-printf` split).
- Defensive parsing: an unknown Codex schema yields a sparser row or no row, never a pane error.
- `CODEX_HOME` = `$CODEX_HOME` env var, else `~/.codex`. Missing `$CODEX_HOME/sessions` → every Codex code path silently off.
- Running Codex rows must never run or copy `codex resume` (live-thread safety); only ended sessions get it.
- Snapshot shape tag bumps `snapshot-5` → `snapshot-6` (the `tool` field changes the stored shape).
- Commits use this repo's conventional style (`feat:`, `docs:`...). **No Claude attribution lines in any commit message or the PR description** (user instruction, overrides harness default).
- The PR description starts with an `## ELI5` section: 2-4 plain sentences, no jargon/file paths (user's global instructions).
- Pre-existing: the 5 tests in `tests/search.test.tsx` (untracked, written against a never-committed UI) already fail on main. Do not fix or delete them; new tests live in `tests/codex.test.tsx` and only those must pass.

## Review Focus

1. `lsof` missing or failing → running Codex rows are simply absent, no pane error. (Test in Task 2.)
2. A rollout file whose first line is not `session_meta` (older Codex) → row skipped silently. (Test in Task 1.)
3. A `codex exec`/automated session (`thread_source` ≠ `"user"`) → excluded from Recent like Claude's `automated`. (Test in Task 1.)
4. `showCodex: false` → no Codex shell calls run, no rows, no tool tags, today's empty-state copy. (Test in Task 3.)
5. Two running Codex rows sharing one daemon pid → Jump copies `cd <cwd>` instead of focusing a guessed window. (Test in Task 2.)

---

### Task 1: Recent Codex sessions — parsing, merge, tags, types

**Files:**
- Modify: `types/index.d.ts`
- Modify: `hooks/register.tsx`
- Modify: `.claude-plugin/plugin.json`
- Test: `tests/codex.test.tsx` (create)

**Interfaces:**
- Consumes: existing `TranscriptInfo`, `RecentInfo`, `recentSessions`, `readTranscript`, `oneLine`, `lastN`, `matchesQuery`.
- Produces (later tasks rely on):
  - `type Tool = 'claude' | 'codex'` in `types/index.d.ts`; `SessionInfo` and `RecentInfo` gain `tool: Tool`; `Snapshot` gains `codexActive?: boolean`; snapshot shape → `'snapshot-6'`.
  - `TranscriptInfo` gains `threadSource?: string` and `lastTask?: 'started' | 'complete'`, and `source?: string` (the `session_meta` `source`/`originator`).
  - `parseCodexTranscript(stdout: string): Omit<TranscriptInfo, 'mtimeMs'>` in `hooks/register.tsx`.
  - `codexHome($): Promise<string>` (`$CODEX_HOME` else `${HOME}/.codex`) and `config.showCodex: boolean`.
  - Shell snippet names (tests mock by these): `newest-codex`, `peek-codex`, `codex-index`.
  - `readTranscript` gains a tool parameter choosing `peek` vs `peek-codex` and `parseTranscript` vs `parseCodexTranscript`.

- [ ] **Step 1: Add the types.** In `types/index.d.ts`: `export type Tool = 'claude' | 'codex'`; add `tool: Tool` to `SessionInfo` and `RecentInfo`; add `codexActive?: boolean` to `Snapshot`. In `register.tsx` bump the snapshot atom shape to `'snapshot-6'` and set `tool: 'claude'` wherever existing rows are built.

- [ ] **Step 2: Add `showCodex` to `plugin.json` `userConfig`** — boolean, title "Show Codex sessions", description "Also list OpenAI Codex CLI sessions (running and recent) found under ~/.codex. Default on.", default `true`. Read it in `register()` as `config.showCodex = options.showCodex !== false`.

- [ ] **Step 3: Write the failing tests** in `tests/codex.test.tsx`, modeled on `tests/search.test.tsx`'s mocking (dispatch on `e.argv[3]`, the `sh -c` name; `claude agents --json` by `e.argv[0] === 'claude'`). Trigger a refresh the way the pane really gets one: `on('command.register', ...)`, `on('ui.open', () => ({ value: { isPlaced: true } }))`, `$.session.start`, then `$.command.run({ command: 'sessions', ... })`, then mount and assert. Fixtures: a Codex `session_meta` line (`{"type":"session_meta","payload":{"cwd":"/home/u/api","thread_source":"user","source":"codex-tui","id":"<uuid>"}}`), two `response_item` user messages (one real, one starting with `# AGENTS.md` to be filtered), a `codex-index` line mapping the uuid to `thread_name: "Fix flaky deploy"`. Tests:
  - `a recent codex session shows with its index title and a codex tag`: `newest-codex` returns one rollout path with mtime; `peek-codex` returns the fixture; assert Text `/Fix flaky deploy/`, Text `/codex/`, and a `resume-<uuid>` button; assert the Claude recent row (from the existing `newest`/`peek` mocks) shows a `/claude/` tag.
  - `a rollout without session_meta is skipped`: `peek-codex` returns only a user message line → no codex row, pane still renders the Claude rows, no error Text.
  - `a non-user thread_source is excluded`: fixture with `thread_source:"subtask"` → no row.
  - `searching for codex filters to codex rows`: type `codex` into the search field; the Claude recent row disappears, the codex one stays.

- [ ] **Step 4: Run tests to verify they fail.** Run: `claude plugin test tests/` — the 4 new tests FAIL (no codex rows rendered); the 5 `search.test.tsx` failures are pre-existing noise.

- [ ] **Step 5: Implement discovery + parsing.**
  - `NEWEST_CODEX` snippet: like `NEWEST` but `find "$1" -mindepth 4 -maxdepth 4 -name 'rollout-*.jsonl'` with the same Darwin/Linux stat split, `[ -d "$1" ] || exit 0`, name `newest-codex`, `$1 = $CODEX_HOME/sessions`.
  - `PEEK_CODEX` snippet (name `peek-codex`): `head -n 1` (session_meta) + `grep -F '"role":"user"' | tail -n 25` + tail-capped grep for tool calls (`custom_tool_call`, command executions) + `tail -c 100000 | grep -oE '"type":"task_(started|complete)"' | tail -n 1`.
  - `parseCodexTranscript`: from `session_meta` take `payload.cwd`, `payload.thread_source` → `threadSource`, `payload.source ?? payload.originator` → `source`; prompts from user-role `response_item` lines' `content[].input_text`, skipping text starting with `<` or `# AGENTS.md`, same `oneLine`/dedupe as Claude's; best-effort `actions` via `describeTool`-style naming, unknown shapes skipped; `lastTask` from the task-event grep.
  - Codex session-id regex: the trailing uuid of `rollout-…-<uuid>.jsonl`.
  - `codexIndex($)`: run `sh -c 'tail -n 2000 "$1" 2>/dev/null || true' codex-index <path>` on `$CODEX_HOME/session_index.jsonl`, parse JSONL into `Map<string, string>` (id → thread_name, later lines win); fetched once per refresh when Codex is active.
  - `readTranscript` dispatches on tool; the transcripts cache keys stay the session id (uuids don't collide).

- [ ] **Step 6: Merge into Recent.** In `recentSessions`: when Codex is active (`config.showCodex` and the sessions dir exists — compute once per refresh, pass in), run `newest` and `newest-codex`, tag each file with its tool, merge mtime-descending before the existing BATCH loop. `toRow` uses the per-file tool for `readTranscript`; codex rows take title from the index map (fallback: none), require `info.cwd`, take branch from `gitInfo(cwd)` (the transcript records none), and are dropped when `threadSource` is set and ≠ `'user'`. Set `tool` on every `RecentInfo`. Store `codexActive` in the snapshot. Add each row's `tool` to the searchable fields in both render filters.

- [ ] **Step 7: Tag the rows.** In the Recent row header (and the running row header, for Task 2's benefit) append a dim ` · claude` / ` · codex` next to the age text, drawn only when `snapshot.codexActive` is true.

- [ ] **Step 8: Run tests to verify the 4 new tests pass.** Run: `claude plugin test tests/` — 4 pass, same 5 pre-existing failures.

- [ ] **Step 9: Commit.** `git add -A tests/codex.test.tsx types/ hooks/ .claude-plugin/plugin.json && git commit -m "feat: list recent Codex sessions beside Claude ones"` (no attribution lines).

### Task 2: Running Codex sessions — lsof, busy/idle, Jump safety

**Files:**
- Modify: `hooks/register.tsx`
- Modify: `types/index.d.ts`
- Test: `tests/codex.test.tsx`

**Interfaces:**
- Consumes: Task 1's `parseCodexTranscript`, `readTranscript(tool)`, tags, `codexActive`.
- Produces: `SessionInfo` gains `pidShared?: boolean`; running Codex rows in `snapshot.list` with `tool: 'codex'`; snippet name `lsof-codex`; `jump($, s, surface)` is tool-aware.

- [ ] **Step 1: Write the failing tests** in `tests/codex.test.tsx`:
  - `a running codex session shows busy with a Jump button`: mock `lsof-codex` → `p4242\ncgcodex\nn/home/u/.codex/sessions/2026/11/20/rollout-...-<uuid>.jsonl\n` (`-Fpcn` format); `peek-codex` fixture whose task grep ends `task_started`; assert a running row with Text `/busy/`, `/codex/`, a `jump-<uuid>` button, and that the uuid does NOT appear under Recent.
  - `task_complete shows idle`: same with `task_complete` → Text `/idle/`.
  - `jump on a shared daemon pid copies cd`: `lsof-codex` returns one pid with two rollout paths; press one row's Jump; assert `$.process.run` was never called with `jump.sh` (`on('process.run')` records argv) and the copied text (mock `ui.copy` result) is `cd '/home/u/api'`-shaped, toast mentions it.
  - `lsof failure shows no running codex rows and no error`: `lsof-codex` → `ok('')`; pane renders, no error Text.

- [ ] **Step 2: Run tests to verify they fail.** Run: `claude plugin test tests/` — new tests FAIL.

- [ ] **Step 3: Implement discovery.** Snippet `lsof-codex`: `command -v lsof >/dev/null 2>&1 || exit 0; lsof -Fpcn +D "$1" 2>/dev/null || true`. Parse `p`/`c`/`n` records; keep only records whose command (`c`) contains `codex` (filters out the hub's own transient `grep`/`tail` holding a file); keep only `n` paths matching the rollout regex. One row per open rollout file; mark `pidShared: true` on every row whose pid carries more than one rollout. In `refresh()`, when Codex is active, build these rows after the Claude ones: `sessionId` from the filename uuid, transcript via `transcriptPath`-equivalent (the lsof `n` path IS the transcript path — no search needed), `readTranscript($, sid, path, mtimeMs, 'codex')`, cwd from the parse (skip the row if absent), `name` = cwd's last folder, repo/branch via `gitInfo`, `kind` = `info.source === 'vscode' ? 'vscode' : 'interactive'`, `status` = `lastTask === 'started' ? 'busy' : lastTask === 'complete' ? 'idle' : (now - mtimeMs < 10_000 ? 'busy' : 'idle')`, `tool: 'codex'`, `isSelf: false`. Add their ids to the `running` set so Recent excludes them. PR lookup rides the existing `prInfo` path.

- [ ] **Step 4: Make `jump` tool-aware.** For `tool === 'codex'`: if `s.pidShared`, skip `jump.sh` entirely — copy `cd <cwd>` and toast why; else call `jump.sh <pid> <kind> <sid> <cwd> codex` and on fallback copy `cd <cwd>` (never `claude attach`, never `codex resume`).

- [ ] **Step 5: Run tests to verify they pass.** Run: `claude plugin test tests/`.

- [ ] **Step 6: Commit.** `git commit -m "feat: show running Codex sessions with safe Jump"`.

### Task 3: jump.sh tool argument, Codex Resume, gating + docs

**Files:**
- Modify: `bin/jump.sh`
- Modify: `hooks/register.tsx`
- Modify: `README.md`
- Test: `tests/codex.test.tsx`

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: `jump.sh <pid> <kind> <sid> <cwd> [tool]`, tool defaulting to `claude`; `resume`/`pressResume` tool-aware.

- [ ] **Step 1: Write the failing tests:**
  - `resume on a codex recent row arms with codex wording and opens via jump.sh with the codex arg`: press `resume-<uuid>` once → toast/Text mentions `codex resume`; press again → recorded `process.run` argv ends `['sh', .../jump.sh, '0', 'resume', <uuid>, <cwd>, 'codex']`; the in-place `/resume` command is never run even when the row's cwd equals the session cwd.
  - `showCodex false runs no codex commands and hides tags`: register with `options.showCodex = false`; mocks record every `process.run`; after a refresh, no `lsof-codex`/`newest-codex`/`peek-codex`/`codex-index` call was made, no `/codex/` Text, and no `· claude` tag either.

- [ ] **Step 2: Run tests to verify they fail.** Run: `claude plugin test tests/`.

- [ ] **Step 3: Extend `bin/jump.sh`.** Fifth arg `tool=${5:-claude}`. In `open_attached`, build `run` as `codex resume $sid` when `tool = codex` and `$1 = --resume`; for `tool = codex` never call `open_attached attach` (the `kind != interactive` branch is Claude-only: guard it with `[ "$tool" = claude ]`). Everything else unchanged.

- [ ] **Step 4: Verify jump.sh by hand, safely.** Run: `PATH=/usr/bin:/bin sh -c 'unset TMUX; sh bin/jump.sh 0 resume test-sid /tmp codex' ` on Linux-style PATH stripping is unreliable on macOS (osascript exists); instead verify with `sh -n bin/jump.sh` (syntax) and `grep -n 'codex resume' bin/jump.sh` showing the command is built only in the `--resume` branch. Expected: syntax OK; no `attach` path reachable with tool=codex (read the diff to confirm).

- [ ] **Step 5: Make register-side Resume tool-aware.** `resume()`: for codex rows skip the `isHere`/`$.command.run({command:'resume'})` path; call `jump.sh 0 resume <sid> <cwd> codex`; fallback copy `cd <cwd> && codex resume <sid>`. `pressResume()` toast says `codex resume` for codex rows. Empty-state line: when `codexActive`, "No other agent sessions running." else today's text.

- [ ] **Step 6: Run tests to verify they pass.** Run: `claude plugin test tests/` — all `codex.test.tsx` tests pass; only the 5 pre-existing `search.test.tsx` failures remain.

- [ ] **Step 7: README.** Short "Codex sessions" section: what shows, the tool tags, `codex resume` on Resume, `showCodex` option, `lsof` needed for *running* Codex detection, nothing changes without `~/.codex`.

- [ ] **Step 8: Commit.** `git commit -m "feat: resume Codex sessions and gate Codex support behind showCodex"`.

### Task 4: Live verification and PR

**Files:** none new.

- [ ] **Step 1: Validate the plugin.** Run: `claude plugin validate .` Expected: OK.

- [ ] **Step 2: Live smoke test on this machine.** Run the real snippets directly: the `lsof-codex` snippet against `~/.codex/sessions` (expect the running session's pid+path), `newest-codex` (expect rollout paths), `peek-codex` on the newest rollout (expect session_meta + user lines + a task event). This checks the real Codex 0.170 schema, not just fixtures.

- [ ] **Step 3: Branch, push, PR.** Work happened on a branch (`codex-sessions`) off `main` (create it at Task 1 Step 1 if not already). `git push -u origin codex-sessions`; `gh pr create` with a description that **starts with `## ELI5`** (2-4 plain sentences, no jargon or file paths), then a What/How/Testing body. **No Claude attribution lines anywhere.**
