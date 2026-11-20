import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Armed, PrInfo, RecentInfo, Search, SessionInfo, Snapshot, Tool } from '../types'

const PANE = 'session-hub'
const TITLE = 'Claude sessions'
const POLL_MS = 5000
// The size the pane asks for: rows when it sits above the prompt (the layout
// caps it at what it can spare), columns when docked beside a fullscreen
// transcript (capped at 45% of the terminal). A size you drag it to wins.
const PANE_ROWS = 40
const PANE_COLUMNS = 100
const GIT_TTL_MS = 30000
// `gh` goes to the network; ask about each branch at most once a minute.
const PR_TTL_MS = 60000
// Hotkeys for the Recent rows; digits belong to the running sessions' Jump,
// s to Search and x to Close.
const RECENT_KEYS = 'abcdefghijklmnopqrtuvwyz'

// The options in plugin.json `userConfig`, set in /config or with
// `claude plugin configure`; read once when the module loads.
const config = { recentCount: 8, promptCount: 3, actionCount: 3, showCodex: true }
// The last n items; slice(-0) would be all of them.
const lastN = <T,>(items: T[], n: number) => (n > 0 ? items.slice(-n) : [])
const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
// `/sessions close` (or off / hide) closes the pane from the prompt.
const CLOSE_ARGS = new Set(['close', 'off', 'hide'])
const HELP_ARGS = new Set(['help', '-h', '--help'])
const USAGE = [
  'Usage: /sessions [-a | <search words> | close | help]',
  '  /sessions          open the pane: running sessions and the most recent ones',
  '  /sessions -a       list every past session (also --all)',
  '  /sessions <words>  search every session (title, prompts, repo, branch, folder)',
  '  /sessions close    close the pane (also off, hide); x or Esc in the pane does too',
  '  /sessions help     show this help (also -h, --help)',
].join('\n')

// The banner: a two-row arcade block font (only the letters it spells), a
// little robot beside it, neon rows fading magenta to cyan.
const GLYPHS: Record<string, [string, string]> = {
  A: ['▄▀█', '█▀█'], B: ['█▄▄', '█▄█'], C: ['█▀▀', '█▄▄'], D: ['█▀▄', '█▄▀'],
  E: ['█▀▀', '██▄'], H: ['█ █', '█▀█'], I: ['█', '█'], L: ['█  ', '█▄▄'],
  N: ['█▄ █', '█ ▀█'], O: ['█▀█', '█▄█'], S: ['█▀', '▄█'], U: ['█ █', '█▄█'], ' ': [' ', ' '],
}
const blockText = (text: string): string[] =>
  [0, 1].map(row => [...text].map(ch => GLYPHS[ch]![row]).join(' '))

const TITLE_WIDE = blockText('CLAUDE SESSION HUB') // 63 columns
// Mid widths: SESSION HUB in blocks, CLAUDE spelled small above it. Stacking
// two block words row on row makes their half-blocks touch and read as a blob.
const TITLE_MID = blockText('SESSION HUB') // 37 columns
const TITLE_MID_LABEL = [...'CLAUDE'].join(' ')
const TAGLINE = 'www.devoriales.com'
// This plugin's version from its plugin.json, read when the session starts.
let version: string | undefined
const ROBOT_COLUMNS = 8 // the robot and the gap after it
const CLOSE_BUTTON_COLUMNS = 12 // the `x Close` button and a gap before it
const NEON = ['#ff4fd8', '#c86bff', '#7c8cff', '#22c7e8']
const CHROME = '#8a8f98'
const EYES = '#ff3b3b'

// Change the shape tag whenever SessionInfo / Snapshot change: it declines
// what an earlier version stored, which outlives a reload.
const snapshot = atom(
  { plugin: 'session-hub', key: 'snapshot' } as const,
  { list: [], recent: [], all: false, checkedAt: 0 } as Snapshot,
  { shape: 'snapshot-6' },
)

// The search field's text. Searching reads the whole history, so typing the
// first letter switches to it (`auto`) and clearing the field switches back.
const search = atom(
  { plugin: 'session-hub', key: 'search' } as const,
  { query: '' } as Search,
  { shape: 'search-1' },
)

/**
 * Whether a session matches what was typed in the search field.
 *
 * `query` is the field's text as typed (never empty here). `fields` are the
 * session's searchable texts: title, prompts, repo, branch, folder and, for a
 * running session, its name and recent tool calls.
 */
function matchesQuery(query: string, fields: (string | undefined)[]): boolean {
  // Every word must appear somewhere, in any order and any field, ignoring case:
  // "acme timeout" finds repo acme-shop with a prompt about a timeout.
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const text = fields.filter(Boolean).join('\n').toLowerCase()
  return words.every(word => text.includes(word))
}

async function setQuery($: EngineInterface, query: string) {
  const { query: before, auto } = await read($, search)
  if (query === before) return
  const { all = false } = await read($, snapshot)
  // Searching needs the whole history; switch to it on the first letter and
  // back once the field is cleared, unless /sessions -a asked for it.
  const wantAll = query !== '' ? true : auto ? false : all
  await update($, search, s => ({ ...s, query, auto: query !== '' ? auto || !all : false }))
  if (wantAll !== all) {
    await update($, snapshot, s => ({ ...s, all: wantAll, recent: [] }))
    void refresh($)
  }
}

// Resume opens a whole new terminal, so it takes two presses: the first marks
// the row and says what it would open, a second within ARM_MS opens it.
const ARM_MS = 5000
const armed = atom(
  { plugin: 'session-hub', key: 'armed' } as const,
  { at: 0 } as Armed,
  { shape: 'armed-1' },
)
const isArmed = (a: Armed, sessionId: string, now: number) =>
  a.sessionId === sessionId && now - a.at < ARM_MS

type AgentRow = {
  pid: number
  cwd: string
  kind: string
  startedAt: number
  sessionId: string
  name?: string
  status?: string
}

type TranscriptInfo = {
  mtimeMs: number
  title?: string
  cwd?: string
  branch?: string
  // Started by an SDK script (`claude -p`, Agent SDK) rather than a person.
  automated?: boolean
  // Codex only: who started the thread ("user") and from where ("codex-tui", "vscode").
  threadSource?: string
  source?: string
  // Codex only: the newest task event; "started" with no "complete" after it means busy.
  lastTask?: 'started' | 'complete'
  prompts: string[]
  allPrompts?: string[]
  actions: string[]
}

// The newest top-level transcripts ("<mtime seconds> <path>" per line, newest
// first), at most $2 of them, or all when $2 is 0. Subagent transcripts sit one
// level deeper and are left out.
const NEWEST = `d="$1/projects"
[ -d "$d" ] || exit 0
if [ "$(uname -s)" = Darwin ]; then
  find "$d" -mindepth 2 -maxdepth 2 -name '*.jsonl' -exec stat -f '%m %N' {} +
else
  find "$d" -mindepth 2 -maxdepth 2 -name '*.jsonl' -printf '%T@ %p\\n'
fi | sort -rn | if [ "$2" -gt 0 ]; then head -n "$2"; else cat; fi`

// Pulls the newest title, user prompts and tool calls out of a transcript
// without loading the whole (often multi-MB) file into the module.
const PEEK = `f="$1"
grep -F '"type":"ai-title"' "$f" | tail -n 1
grep -F '"message":{"role":"user","content":"' "$f" | tail -n 25
tail -c 400000 "$f" | grep -F '"type":"assistant"' | grep -F '"type":"tool_use"' | tail -n 8`

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const describeTool = (name: string, input: Record<string, unknown>, cwd?: string) => {
  let pick = ['description', 'command', 'file_path', 'pattern', 'url', 'query', 'skill', 'prompt']
    .map(k => input[k])
    .find(v => typeof v === 'string' && v.length > 0) as string | undefined
  // A file in the session's own folder reads better relative: "Edit: src/server.js".
  if (pick && cwd && pick === input.file_path && pick.startsWith(`${cwd}/`)) pick = pick.slice(cwd.length + 1)
  const short = name.replace(/^mcp__([^_]+)__/, '$1:')
  return pick ? `${short}: ${oneLine(pick, 70)}` : short
}

const parseTranscript = (stdout: string): Omit<TranscriptInfo, 'mtimeMs'> => {
  let title: string | undefined
  let cwd: string | undefined
  let branch: string | undefined
  let automated = false
  const prompts: string[] = []
  const actions: string[] = []

  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue // the first line of a `tail -c` cut is usually partial
    }
    if (row.type === 'ai-title' && typeof row.aiTitle === 'string') title = row.aiTitle
    if (row.type === 'user' && typeof row.cwd === 'string') {
      cwd = row.cwd
      if (typeof row.entrypoint === 'string' && row.entrypoint.startsWith('sdk')) automated = true
      if (typeof row.gitBranch === 'string' && row.gitBranch !== 'HEAD') branch = row.gitBranch
    }
    if (row.type === 'user' && !row.isMeta && !row.isCompactSummary && typeof row.message?.content === 'string') {
      const text: string = row.message.content
      if (/^(<|\[Request interrupted|This session is being continued)/.test(text)) continue
      const flat = oneLine(text, 90)
      if (flat && prompts.at(-1) !== flat) prompts.push(flat)
    }
    if (row.type === 'assistant' && Array.isArray(row.message?.content)) {
      for (const block of row.message.content) {
        if (block?.type === 'tool_use') actions.push(describeTool(block.name, block.input ?? {}, cwd))
      }
    }
  }

  return { title, cwd, branch, automated, prompts: lastN(prompts, config.promptCount), allPrompts: prompts, actions: lastN(actions, config.actionCount) }
}

// A Codex tool call: `name` plus `input` (a code string) or `arguments` (a JSON string).
const describeCodexTool = (payload: any): string | undefined => {
  if (typeof payload?.name !== 'string') return undefined
  let pick: unknown = typeof payload.input === 'string' ? payload.input : undefined
  if (!pick && typeof payload.arguments === 'string') {
    try {
      const args = JSON.parse(payload.arguments)
      pick = ['description', 'command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'prompt']
        .map(k => args?.[k])
        .find(v => typeof v === 'string' && v.length > 0)
    } catch {
      /* not JSON: show just the name */
    }
  }
  return typeof pick === 'string' && pick ? `${payload.name}: ${oneLine(pick, 70)}` : payload.name
}

// PEEK_CODEX's output: session_meta, user messages, tool calls, last task event.
const parseCodexTranscript = (stdout: string): Omit<TranscriptInfo, 'mtimeMs'> => {
  let cwd: string | undefined
  let branch: string | undefined
  let threadSource: string | undefined
  let source: string | undefined
  let lastTask: TranscriptInfo['lastTask']
  const prompts: string[] = []
  const actions: string[] = []

  for (const line of stdout.split('\n')) {
    if (line === '"type":"task_started"') lastTask = 'started'
    // An interrupted turn ends it too; without this an abort leaves "busy" stuck.
    if (line === '"type":"task_complete"' || line === '"type":"turn_aborted"') lastTask = 'complete'
    if (!line.startsWith('{')) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const payload = row?.payload
    if (row?.type === 'session_meta' && payload) {
      if (typeof payload.cwd === 'string') cwd = payload.cwd
      if (typeof payload.thread_source === 'string') threadSource = payload.thread_source
      if (typeof payload.source === 'string') source = payload.source
      else if (typeof payload.originator === 'string') source = payload.originator
      // The branch the session was started on; the folder's current checkout
      // may have moved on since.
      if (typeof payload.git?.branch === 'string' && payload.git.branch !== 'HEAD') branch = payload.git.branch
    }
    if (payload?.role === 'user' && Array.isArray(payload.content)) {
      for (const block of payload.content) {
        const text = block?.type === 'input_text' ? block.text : undefined
        // Codex injects AGENTS.md and <environment_context>-style messages as "user".
        if (typeof text !== 'string' || /^(<|# AGENTS\.md)/.test(text)) continue
        const flat = oneLine(text, 90)
        if (flat && prompts.at(-1) !== flat) prompts.push(flat)
      }
    }
    if (['custom_tool_call', 'function_call', 'local_shell_call'].includes(payload?.type)) {
      const described = describeCodexTool(payload)
      if (described) actions.push(described)
    }
  }

  return { cwd, branch, threadSource, source, lastTask, prompts: lastN(prompts, config.promptCount), allPrompts: prompts, actions: lastN(actions, config.actionCount) }
}

const SESSION_FILE = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

// Codex (the OpenAI CLI) writes transcripts to
// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl.
const CODEX_FILE = /\/rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

// The newest Codex transcripts, same "<mtime seconds> <path>" lines as NEWEST.
const NEWEST_CODEX = `d="$1/sessions"
[ -d "$d" ] || exit 0
if [ "$(uname -s)" = Darwin ]; then
  find "$d" -mindepth 4 -maxdepth 4 -name 'rollout-*.jsonl' -exec stat -f '%m %N' {} +
else
  find "$d" -mindepth 4 -maxdepth 4 -name 'rollout-*.jsonl' -printf '%T@ %p\\n'
fi | sort -rn | if [ "$2" -gt 0 ]; then head -n "$2"; else cat; fi`

// The interesting lines of a Codex transcript: the session_meta header, the
// newest user prompts and tool calls, and the last task started/complete
// event (busy or idle).
const PEEK_CODEX = `f="$1"
head -n 1 "$f"
grep -F '"role":"user"' "$f" | tail -n 25
tail -c 400000 "$f" | grep -E '"type":"(custom_tool_call|function_call|local_shell_call)"' | tail -n 8
tail -c 100000 "$f" | grep -oE '"type":"(task_started|task_complete|turn_aborted)"' | tail -n 1`

// Codex keeps each session's title here; ids repeat, the newest line wins.
const CODEX_INDEX = `tail -n 2000 "$1/session_index.jsonl" 2>/dev/null || true`

// A running Codex session holds its rollout file open; lsof is the only
// process-to-session map Codex offers. -F gives one field per line: p pid,
// c command, n path. No lsof, or none open, prints nothing.
// "nolsof" tells the caller liveness is UNKNOWN, as opposed to "none running":
// without it, a live session would be offered under Recent with a working Resume.
const LSOF_CODEX = `command -v lsof >/dev/null 2>&1 || { echo nolsof; exit 0; }
lsof -Fpcn +D "$1/sessions" 2>/dev/null || true`

// lsof -Fpcn output -> one entry per open rollout file, with how many files
// its pid holds (a shared daemon pid can't be focused unambiguously).
const parseLsof = (stdout: string) => {
  let pid = 0
  let command = ''
  // By session id: one file on several descriptors (or pids) is one session.
  const open = new Map<string, { pid: number; path: string; sid: string }>()
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    if (line.startsWith('c')) command = line.slice(1)
    if (!line.startsWith('n') || !command.includes('codex')) continue // skips our own grep/tail peeks
    const sid = CODEX_FILE.exec(line.slice(1))?.[1]
    if (sid && pid > 0 && !open.has(sid)) open.set(sid, { pid, path: line.slice(1), sid })
  }
  return [...open.values()]
}

// Claude Code names a session "<folder>-<short code>" (e.g. "lime-cloud-cf");
// show just the folder. A name set any other way is shown as given.
const displayName = (name: string | undefined, cwd: string, sessionId: string) => {
  if (!name) return sessionId.slice(0, 8)
  const folder = cwd.split('/').filter(Boolean).pop()
  return folder && name.startsWith(`${folder}-`) && /^[0-9a-z]{1,4}$/i.test(name.slice(folder.length + 1))
    ? folder
    : name
}

const tilde = (path: string, home: string | undefined) =>
  home && path.startsWith(home) ? `~${path.slice(home.length)}` : path

const ago = (ms: number, now: number) => {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

// Module-level caches start over on every reload; that is fine.
const transcripts = new Map<string, TranscriptInfo>()
const git = new Map<string, { at: number; repo?: string; branch?: string }>()
// Holds the lookup itself, so two sessions on one branch share a single `gh` call.
const prs = new Map<string, { at: number; pr: Promise<PrInfo | undefined> }>()
let ticking = false
let timer: { cancel: () => void } | undefined

async function transcriptPath($: EngineInterface, base: string, cwd: string, sid: string) {
  const direct = `${base}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${sid}.jsonl`
  if (await $.fs.exists(direct)) return direct
  // Very long paths get shortened by Claude Code; look for the file instead.
  for (const dir of await $.fs.list(`${base}/projects`)) {
    const candidate = `${base}/projects/${dir.name}/${sid}.jsonl`
    if (dir.kind === 'dir' && (await $.fs.exists(candidate))) return candidate
  }
  return undefined
}

// Reads a transcript's title, prompts and actions, re-reading it only when it changed.
async function readTranscript($: EngineInterface, sid: string, path: string, mtimeMs: number, tool: Tool = 'claude') {
  const cached = transcripts.get(sid)
  if (cached && cached.mtimeMs === mtimeMs) return cached
  const [script, name, parse] =
    tool === 'codex' ? ([PEEK_CODEX, 'peek-codex', parseCodexTranscript] as const) : ([PEEK, 'peek', parseTranscript] as const)
  const peek = await $.process.run(['sh', '-c', script, name, path], { timeoutMs: 10000 })
  const info: TranscriptInfo = { mtimeMs, ...parse(peek.stdout) }
  transcripts.set(sid, info)
  return info
}

// $CODEX_HOME, else ~/.codex; Codex support is active when its sessions dir exists.
async function codexBase($: EngineInterface, home: string | undefined) {
  if (!config.showCodex) return undefined
  const base = (await $.env.get('CODEX_HOME')) ?? `${home}/.codex`
  return (await $.fs.exists(`${base}/sessions`).catch(() => false)) ? base : undefined
}

// Codex session titles, newest line per id wins.
async function codexTitles($: EngineInterface, base: string) {
  const res = await $.process.run(['sh', '-c', CODEX_INDEX, 'codex-index', base], { timeoutMs: 10000 }).catch(() => undefined)
  const titles = new Map<string, string>()
  for (const line of (res?.stdout ?? '').split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const row = JSON.parse(line)
      if (typeof row?.id === 'string' && typeof row?.thread_name === 'string') titles.set(row.id, row.thread_name)
    } catch {
      /* a cut or foreign line */
    }
  }
  return titles
}

// The newest sessions that are not running, with at least one prompt; every
// such session when `all` is set. Transcripts are read BATCH at a time, and
// `progress` gets the rows found so far after each batch, so a first `-a` over
// hundreds of transcripts fills the pane as it goes instead of all at the end.
const BATCH = 8

async function recentSessions(
  $: EngineInterface,
  base: string,
  codex: string | undefined,
  titles: Map<string, string> | undefined,
  running: Set<string>,
  home: string | undefined,
  now: number,
  all: boolean,
  progress?: (rows: RecentInfo[]) => Promise<unknown>,
) {
  const limit = all ? '0' : '60'
  const timeoutMs = all ? 30000 : 10000
  const [res, codexRes] = await Promise.all([
    $.process.run(['sh', '-c', NEWEST, 'newest', base, limit], { timeoutMs }),
    codex ? $.process.run(['sh', '-c', NEWEST_CODEX, 'newest-codex', codex, limit], { timeoutMs }).catch(() => undefined) : undefined,
  ])
  const parseFind = (stdout: string, tool: Tool) =>
    stdout.split('\n').flatMap(line => {
      const space = line.indexOf(' ')
      const path = line.slice(space + 1)
      const sid = (tool === 'codex' ? CODEX_FILE : SESSION_FILE).exec(path)?.[1]
      if (space < 0 || !sid || running.has(sid)) return []
      return [{ sid, path, tool, mtimeMs: Math.round(Number(line.slice(0, space)) * 1000) }]
    })
  const files = [...parseFind(res.stdout, 'claude'), ...parseFind(codexRes?.stdout ?? '', 'codex')]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  const toRow = async ({ sid, path, tool, mtimeMs }: (typeof files)[number]) => {
    const info = await readTranscript($, sid, path, mtimeMs, tool).catch(() => undefined)
    if (!info?.cwd || info.automated || info.prompts.length === 0) return undefined
    // Codex harness runs (`codex exec`, subtasks) are not resumable conversations.
    if (tool === 'codex' && info.threadSource && info.threadSource !== 'user') return undefined
    const { repo, branch: cwdBranch } = await gitInfo($, info.cwd, now)
    const branch = info.branch ?? (tool === 'codex' ? cwdBranch : undefined)
    const item: RecentInfo = {
      sessionId: sid,
      tool,
      title: tool === 'codex' ? titles?.get(sid) : info.title,
      cwd: tilde(info.cwd, home),
      repo,
      branch,
      // A past session shows one prompt fewer than a running one; the full history only its last.
      prompts: lastN(info.prompts, all ? Math.min(1, config.promptCount) : Math.max(0, config.promptCount - 1)),
      allPrompts: info.allPrompts,
      activeAt: mtimeMs,
    }
    return { item, cwd: info.cwd, branch }
  }

  const found: NonNullable<Awaited<ReturnType<typeof toRow>>>[] = []
  for (let i = 0; i < files.length; i += BATCH) {
    if (!all && found.length >= config.recentCount) break
    const rows = await Promise.all(files.slice(i, i + BATCH).map(toRow))
    for (const row of rows) if (row) found.push(row)
    if (all && progress) await progress(found.map(r => r.item))
  }
  const top = found.slice(0, all ? found.length : config.recentCount)

  await Promise.all(
    // `gh` goes to the network: in the full history only the newest rows get a PR lookup.
    top.slice(0, config.recentCount).map(r => prInfo($, r.cwd, r.branch, now).then(pr => void (r.item.pr = pr))),
  )
  return top.map(r => r.item)
}

async function gitInfo($: EngineInterface, cwd: string, now: number) {
  const cached = git.get(cwd)
  if (cached && now - cached.at < GIT_TTL_MS) return cached
  const out = await $.process
    .run(['git', '-C', cwd, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 })
    .catch(() => undefined)
  const [top, branch] = out?.exitCode === 0 ? out.stdout.trim().split('\n') : []
  const info = { at: now, repo: top ? top.split('/').pop() : undefined, branch }
  git.set(cwd, info)
  return info
}

// Folds a PR's check runs and status contexts into one verdict.
const rollUp = (checks: any[] | undefined): PrInfo['checks'] => {
  if (!Array.isArray(checks) || checks.length === 0) return undefined
  const verdicts = checks.map(c => String(c?.conclusion || c?.state || c?.status || '').toUpperCase())
  if (verdicts.some(v => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(v)))
    return 'fail'
  if (verdicts.some(v => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING', 'REQUESTED', ''].includes(v)))
    return 'pending'
  return 'pass'
}

async function lookUpPr($: EngineInterface, cwd: string, branch: string): Promise<PrInfo | undefined> {
  const res = await $.process
    .run(
      ['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--limit', '1',
        '--json', 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup'],
      { cwd, timeoutMs: 10000 },
    )
    .catch(() => undefined)
  // No `gh`, not logged in, no GitHub remote, or the folder is gone: show nothing.
  if (res?.exitCode !== 0) return undefined
  const [row] = JSON.parse(res.stdout || '[]')
  if (!row) return undefined
  return {
    number: row.number,
    title: row.title,
    url: row.url,
    state: row.state,
    isDraft: Boolean(row.isDraft),
    checks: rollUp(row.statusCheckRollup),
    review: row.reviewDecision || undefined,
  }
}

// The newest PR from this branch, if any. Default branches are skipped: a PR
// "from main" is almost never what the session is about.
function prInfo($: EngineInterface, cwd: string, branch: string | undefined, now: number) {
  if (!branch || /^(main|master|HEAD)$/.test(branch)) return Promise.resolve(undefined)
  const key = `${cwd}\0${branch}`
  const cached = prs.get(key)
  if (cached && now - cached.at < PR_TTL_MS) return cached.pr
  const pr = lookUpPr($, cwd, branch).catch(() => undefined)
  prs.set(key, { at: now, pr })
  return pr
}

async function refresh($: EngineInterface) {
  if (ticking) return
  ticking = true
  try {
    const now: number = await $.clock.now()
    const selfId: string = await $.session.id()
    const home = await $.env.get('HOME')
    const base = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
    const codex = await codexBase($, home)
    const { all = false } = await read($, snapshot)

    const res = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: 15000 })
    if (res.exitCode !== 0) throw new Error(oneLine(res.stderr || 'claude agents --json failed', 200))
    const rows: AgentRow[] = JSON.parse(res.stdout)

    const list: SessionInfo[] = []
    const prJobs: Promise<void>[] = []
    for (const row of rows) {
      let info: TranscriptInfo = { mtimeMs: row.startedAt, prompts: [], actions: [] }
      const path = await transcriptPath($, base, row.cwd, row.sessionId).catch(() => undefined)
      if (path) {
        const { mtimeMs } = await $.fs.stat(path)
        info = await readTranscript($, row.sessionId, path, mtimeMs)
      }
      const { repo, branch } = await gitInfo($, row.cwd, now)

      const item: SessionInfo = {
        sessionId: row.sessionId,
        pid: row.pid,
        name: displayName(row.name, row.cwd, row.sessionId),
        title: info.title,
        cwd: tilde(row.cwd, home),
        repo,
        branch,
        kind: row.kind,
        status: row.status ?? 'unknown',
        isSelf: row.sessionId === selfId,
        tool: 'claude',
        prompts: info.prompts,
        actions: info.actions,
        activeAt: info.mtimeMs,
      }
      list.push(item)
      prJobs.push(prInfo($, row.cwd, branch, now).then(pr => void (item.pr = pr)))
    }

    const titles = codex ? await codexTitles($, codex) : undefined
    // Whether running-Codex discovery actually ran: lsof present and answering.
    // Unknown liveness means a "recent" Codex session may in fact be live.
    let codexLive = false
    if (codex) {
      const lres = await $.process
        .run(['sh', '-c', LSOF_CODEX, 'lsof-codex', codex], { timeoutMs: 10000 })
        .catch(() => undefined)
      codexLive = lres !== undefined && !lres.stdout.startsWith('nolsof')
      const open = parseLsof(lres?.stdout ?? '')
      const perPid = new Map<number, number>()
      for (const o of open) perPid.set(o.pid, (perPid.get(o.pid) ?? 0) + 1)
      for (const o of open) {
        const { mtimeMs } = await $.fs.stat(o.path).catch(() => ({ mtimeMs: now }))
        const info = await readTranscript($, o.sid, o.path, mtimeMs, 'codex').catch(() => undefined)
        if (!info?.cwd) continue
        const { repo, branch } = await gitInfo($, info.cwd, now)
        const item: SessionInfo = {
          sessionId: o.sid,
          pid: o.pid,
          name: info.cwd.split('/').filter(Boolean).pop() ?? o.sid.slice(0, 8),
          title: titles?.get(o.sid),
          cwd: tilde(info.cwd, home),
          repo,
          branch,
          kind: info.source === 'vscode' ? 'vscode' : 'interactive',
          // Codex reports no status; its transcript's task events are the best signal.
          status:
            info.lastTask === 'started' ? 'busy'
            : info.lastTask === 'complete' ? 'idle'
            : now - mtimeMs < 10000 ? 'busy' : 'idle',
          isSelf: false,
          tool: 'codex',
          pidShared: (perPid.get(o.pid) ?? 0) > 1,
          prompts: info.prompts,
          actions: info.actions,
          activeAt: mtimeMs,
        }
        list.push(item)
        prJobs.push(prInfo($, info.cwd, branch, now).then(pr => void (item.pr = pr)))
      }
    }

    // Busy first, then most recently active; this session last.
    list.sort(
      (a, b) =>
        Number(a.isSelf) - Number(b.isSelf) ||
        Number(b.status === 'busy') - Number(a.status === 'busy') ||
        b.activeAt - a.activeAt,
    )
    const running = new Set(list.map(r => r.sessionId))
    // Show the history as it is read the first time. Later polls already have a
    // full list on screen, so a shorter partial one is skipped rather than flashed;
    // so is any once the mode has flipped back.
    const progress = (partial: RecentInfo[]) =>
      update($, snapshot, s =>
        (s.all ?? false) === all && partial.length > (s.recent?.length ?? 0)
          ? { ...s, list, recent: partial, checkedAt: now }
          : s,
      )
    // A failure here still lets the running sessions show; it is reported, not hidden.
    let historyError: string | undefined
    const recent = await recentSessions($, base, codex, titles, running, home, now, all, progress).catch(error => {
      historyError = `Couldn't read session history: ${error instanceof Error ? error.message : String(error)}`
      return [] as RecentInfo[]
    })
    await Promise.all(prJobs)
    const codexActive = codex !== undefined
    // If the mode flipped while this ran, keep the newer choice; the next tick fills it in.
    await update($, snapshot, s =>
      (s.all ?? false) === all
        ? { list, recent, all, codexActive, codexLive, checkedAt: now, error: historyError }
        : { ...s, list, codexActive, codexLive, checkedAt: now, error: historyError },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await update($, snapshot, s => ({ ...s, error: message }))
  } finally {
    ticking = false
  }
}

async function jump($: EngineInterface, s: SessionInfo, surface: any) {
  const root: string = $.plugin.root
  const cwd = await expandHome($, s.cwd)
  // A Codex daemon pid holding several transcripts could belong to any of
  // their windows; focusing would guess, so hand over the folder instead.
  if (s.tool === 'codex' && s.pidShared) {
    const command = `cd ${JSON.stringify(cwd)}`
    await $.ui.copy({ text: command, surface })
    return $.ui.toast(`Can't tell ${s.name}'s window apart from another Codex session's. Copied: ${command}`, {
      timeoutMs: 8000,
    })
  }
  const res = await $.process
    .run(['sh', `${root}/bin/jump.sh`, String(s.pid), s.kind, s.sessionId, cwd, s.tool], { timeoutMs: 15000 })
    .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  const [verdict, ...rest] = res.stdout.trim().split(' ')
  const how = rest.join(' ')

  if (verdict === 'focused') return $.ui.toast(`Switched to ${s.name} (${how})`)
  if (verdict === 'opened') return $.ui.toast(`Opened ${s.name} in a new ${how} window`)

  // Never `codex resume` here: against a live session it could fork the thread.
  const command =
    s.tool === 'codex' || s.kind === 'interactive' ? `cd ${JSON.stringify(cwd)}` : `claude attach ${s.sessionId}`
  await $.ui.copy({ text: command, surface })
  $.ui.toast(
    `Couldn't focus ${s.name}${how && how !== 'none' ? ` (it runs on ${how})` : ''}. Copied: ${command}`,
    { timeoutMs: 8000 },
  )
}

// First press: mark the row and say what a second press opens. Second press
// on the same row within ARM_MS: open it.
async function pressResume($: EngineInterface, r: RecentInfo, key: string | undefined, surface: any) {
  const now = await $.clock.now()
  if (isArmed(await read($, armed), r.sessionId, now)) {
    await update($, armed, () => ({ at: 0 }))
    return resume($, r, surface)
  }
  await update($, armed, () => ({ sessionId: r.sessionId, at: now }))
  const label = r.title ?? r.prompts.at(-1) ?? r.sessionId.slice(0, 8)
  const again = key ? `Press ${key} again` : 'Click Resume again'
  const { codexLive = false } = await read($, snapshot)
  // Only Claude sessions can replace this conversation; Codex always gets its
  // own terminal, and only a command copy when liveness can't be checked.
  const where =
    r.tool === 'codex' && !codexLive
      ? 'as a copied codex resume command (lsof unavailable, it may still be running)'
      : r.tool !== 'codex' && (await isHere($, r))
        ? 'here, replacing this conversation'
        : `(${r.cwd}) in a new terminal`
  $.ui.toast(`${again} to open “${oneLine(label, 60)}” ${where}`, { timeoutMs: ARM_MS })
}

async function expandHome($: EngineInterface, path: string) {
  return path.startsWith('~') ? `${await $.env.get('HOME')}${path.slice(1)}` : path
}

// /resume only switches in place to a session from this session's folder; one
// from elsewhere gets a new terminal in its own folder instead.
async function isHere($: EngineInterface, r: RecentInfo) {
  return (await expandHome($, r.cwd)) === (await $.session.cwd())
}

async function resume($: EngineInterface, r: RecentInfo, surface: any) {
  const cwd = await expandHome($, r.cwd)
  const label = r.title ?? r.sessionId.slice(0, 8)
  if (!(await $.fs.exists(cwd).catch(() => false))) {
    return $.ui.toast(`Can't resume ${label}: ${r.cwd} no longer exists`, { timeoutMs: 8000 })
  }
  if (r.tool === 'codex') {
    const { codexLive = false } = await read($, snapshot)
    if (!codexLive) {
      // Without lsof we can't prove this session has ended; resuming a live
      // Codex thread could fork it, so hand over the command instead.
      const command = `cd ${JSON.stringify(cwd)} && codex resume ${r.sessionId}`
      await $.ui.copy({ text: command, surface })
      return $.ui.toast(
        `Can't check whether “${oneLine(label, 50)}” is still running (lsof unavailable), so it wasn't opened. Copied: ${command}`,
        { timeoutMs: 8000 },
      )
    }
  }
  // /resume is Claude's; a Codex session always opens in its own terminal.
  if (r.tool !== 'codex' && (await isHere($, r))) {
    const ran = await $.command
      .run({ command: 'resume', args: r.sessionId })
      .then(() => true, () => false)
    if (ran) return
    // Fall through to a new terminal if /resume was refused.
  }
  const res = await $.process
    .run(['sh', `${$.plugin.root}/bin/jump.sh`, '0', 'resume', r.sessionId, cwd, r.tool], { timeoutMs: 15000 })
    .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  const [verdict, ...rest] = res.stdout.trim().split(' ')
  if (verdict === 'opened') return $.ui.toast(`Resumed ${label} in a new ${rest.join(' ')} window`)

  const command =
    r.tool === 'codex'
      ? `cd ${JSON.stringify(cwd)} && codex resume ${r.sessionId}`
      : `cd ${JSON.stringify(cwd)} && claude --resume ${r.sessionId}`
  await $.ui.copy({ text: command, surface })
  $.ui.toast(`Couldn't open a terminal. Copied: ${command}`, { timeoutMs: 8000 })
}

const PR_STATE = {
  OPEN: { label: 'open', color: 'green' },
  DRAFT: { label: 'draft', color: 'gray' },
  MERGED: { label: 'merged', color: 'magenta' },
  CLOSED: { label: 'closed', color: 'red' },
} as const
const CHECKS = { pass: ['✓', 'green'], fail: ['✗', 'red'], pending: ['…', 'yellow'] } as const
const REVIEW = {
  APPROVED: ['approved', 'green'],
  CHANGES_REQUESTED: ['changes requested', 'red'],
  REVIEW_REQUIRED: ['review needed', 'yellow'],
} as const

// One line: "⇡ #42 open · checks ✓ · approved  <title>", the number a link.
function PrLine({ pr, els }: { pr: PrInfo; els: { Box: any; Text: any; Link: any } }) {
  const { Box, Text, Link } = els
  const state = PR_STATE[pr.isDraft && pr.state === 'OPEN' ? 'DRAFT' : pr.state] ?? PR_STATE.OPEN
  const checks = pr.checks && pr.state === 'OPEN' ? CHECKS[pr.checks] : undefined
  const review = pr.review && pr.state === 'OPEN' ? REVIEW[pr.review] : undefined
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={state.color}>⇡</Text>
      {/* Keep the number whole; only the title gives way when the row is narrow. */}
      <Box flexShrink={0}>
        <Text>
          <Link href={pr.url} label={`#${pr.number}`} />
        </Text>
      </Box>
      <Text wrap="truncate-end">
        <Text color={state.color}>{state.label}</Text>
        {checks && (
          <Text>
            <Text dimColor> · checks </Text>
            <Text color={checks[1]}>{checks[0]}</Text>
          </Text>
        )}
        {review && (
          <Text>
            <Text dimColor> · </Text>
            <Text color={review[1]}>{review[0]}</Text>
          </Text>
        )}
        <Text dimColor>  {pr.title}</Text>
      </Text>
    </Box>
  )
}

export const register: Register = (on, options) => {
  config.recentCount = clampInt(options.recentCount, 1, RECENT_KEYS.length, 8)
  config.promptCount = clampInt(options.promptCount, 0, 10, 3)
  config.actionCount = clampInt(options.actionCount, 0, 10, 3)
  config.showCodex = options.showCodex !== false

  on('session.start', async ($, e, next) => {
    version = await $.fs
      .read(`${$.plugin.root}/.claude-plugin/plugin.json`)
      .then(text => JSON.parse(String(text)).version as string | undefined)
      .catch(() => undefined)
    await $.command.register({
      name: 'sessions',
      description: 'Show every running Claude Code session in a pane (/sessions help lists the options)',
      argumentHint: '[-a | close | help]',
    })
    // The pane opens only on `/sessions`; until then the poll below does nothing.
    timer?.cancel()
    timer = $.clock.every(POLL_MS, async () => {
      // Only poll while the pane is actually up.
      const panes = await $.ui.panes()
      if (panes.some(p => p.id === PANE && p.isPlaced)) await refresh($)
    })

    return next(e)
  })

  // Esc first clears a search and keeps the pane; with no search it closes it.
  // Only the person's close (Esc, the close mark) is held back; x and
  // /sessions close go through $.ui.close and always close.
  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE || e.origin.kind !== 'person') return next(e)
    const { query } = await read($, search)
    if (!query) return next(e)
    await setQuery($, '')
    await update($, search, s => ({ ...s, rev: (s.rev ?? 0) + 1 }))
    $.ui.toast('Search cleared. Esc again closes the pane.', { timeoutMs: 3000 })
    return { deny: 'Esc cleared the search instead' }
  })

  on('command.run', { command: 'sessions' }, async ($, e) => {
    const flags = e.args.trim().split(/\s+/).filter(Boolean)
    if (flags.length === 1 && HELP_ARGS.has(flags[0]!)) return { text: USAGE }
    if (flags.length === 1 && CLOSE_ARGS.has(flags[0]!)) {
      const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
      if (!isOpen) return { text: 'The sessions pane is not open.' }
      await $.ui.close({ id: PANE })
      return { text: 'Sessions pane closed. /sessions opens it again.' }
    }
    const options = flags.filter(f => f.startsWith('-'))
    const unknown = options.filter(f => f !== '-a' && f !== '--all')
    if (unknown.length > 0) return { text: `Unknown option ${unknown.join(' ')}.\n${USAGE}` }
    // Anything that isn't an option is a search: `/sessions checkout timeout`.
    const query = flags.filter(f => !f.startsWith('-')).join(' ')
    const all = options.length > 0 || query !== ''
    // Switching modes empties the list below the running sessions until it is read again.
    await update($, snapshot, s => ((s.all ?? false) === all ? s : { ...s, all, recent: [] }))
    // A new key too, so the field shows this query even over text typed earlier.
    await update($, search, s => ({ query, auto: query !== '' && options.length === 0, rev: (s.rev ?? 0) + 1 }))
    await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true, rows: PANE_ROWS, columns: PANE_COLUMNS })
    // Reading every transcript the first time can take a while, so don't hold the
    // command; a tick already under way skips this one and the 5 s poll catches up.
    void refresh($)

    return {
      text: query
        ? `Sessions pane opened, searching every session for “${query}”. Press a row letter or click Resume to reopen one. x or Esc closes it.`
        : all
        ? 'Sessions pane opened with every past session. Press a row letter or click Resume to reopen one; arrows scroll. /sessions shows recent only again. x or Esc closes it.'
        : 'Sessions pane opened. Press a number (or click Jump) to switch; x or Esc closes it.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Input } = $.ui.resolve(e)
    const els = { Box, Text, Link }
    const { list: allRunning, recent: allRecent = [], all = false, codexActive = false, codexLive = false, error, checkedAt } = await read($, snapshot)
    const { query, rev = 0 } = await read($, search)
    const searchKey = `search-${rev}`
    const q = query.trim()
    const pending = await read($, armed)
    const now = await $.clock.now()
    // While searching, only matching rows are drawn; hotkeys go to what is drawn.
    const list = q
      ? allRunning.filter(s => matchesQuery(q, [s.tool, s.name, s.title, s.repo, s.branch, s.cwd, ...s.prompts, ...s.actions]))
      : allRunning
    const recent = q
      ? allRecent.filter(r => matchesQuery(q, [r.tool, r.title, r.repo, r.branch, r.cwd, ...(r.allPrompts ?? r.prompts)]))
      : allRecent
    const others = list.filter(s => !s.isSelf)
    // Enter in the search field moves onto the first result's button.
    const firstMatch = others[0]
      ? `jump-${others[0].sessionId}`
      : recent[0] ? `resume-${recent[0].sessionId}` : undefined
    const home = await $.env.get('HOME')
    const selfCwd = tilde(await $.session.cwd(), home)
    // Room left for the banner beside the Close button.
    const width = e.props.bodyColumns - CLOSE_BUTTON_COLUMNS
    const isWide = width >= ROBOT_COLUMNS + TITLE_WIDE[0]!.length
    const isMid = !isWide && width >= ROBOT_COLUMNS + TITLE_MID[0]!.length
    const tagline = (
      <Text>
        <Text color={NEON[0]}>░▒▓ </Text>
        <Text dimColor>{TAGLINE}</Text>
        <Text color={NEON[3]}> ▓▒░</Text>
      </Text>
    )
    const robot = [
      <Text color={CHROME}> ▄▀▀▀▄  </Text>,
      <Text color={CHROME}> █<Text color={EYES} bold>▪</Text> <Text color={EYES} bold>▪</Text>█  </Text>,
      <Text color={CHROME}> █═══█  </Text>,
      <Text color={CHROME}> ▀▀ ▀▀  </Text>,
    ]
    // Beside each robot row: a title row in its neon, or the tagline.
    const beside = isWide
      ? [undefined, TITLE_WIDE[0], TITLE_WIDE[1], tagline]
      : [<Text color={NEON[1]} bold>{TITLE_MID_LABEL}</Text>, TITLE_MID[0], TITLE_MID[1], tagline]
    const banner = (isWide || isMid) ? (
      <Box flexDirection="column">
        {robot.map((part, i) => {
          const right = beside[i]
          return (
            <Text key={`banner-${i}`}>
              {part}
              {typeof right === 'string' ? <Text color={NEON[i === 1 ? 0 : 3]} bold>{right}</Text> : right}
            </Text>
          )
        })}
        {version && <Text>{' '.repeat(ROBOT_COLUMNS + 4)}v{version}</Text>}
      </Box>
    ) : (
      <Text>
        <Text color={NEON[0]} bold>▓▒░ CLAUDE </Text>
        <Text color={NEON[2]} bold>SESSION HUB ░▒▓</Text>
        <Text dimColor> devoriales</Text>
        {version && <Text> v{version}</Text>}
      </Text>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start">
          {banner}
          <Button label="x Close" hotkey="x" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
        {/* `s` jumps into the field; Esc or Enter hands the keys back to the hotkeys. */}
        <Box flexDirection="row" gap={1}>
          <Button
            key="search-button"
            label="s Search"
            hotkey="s"
            onPress={() => void $.ui.focus({ requestId: PANE, key: searchKey })}
          />
          <Box flexGrow={1}>
            <Input
              key={searchKey}
              placeholder="title, prompt, repo, branch or folder"
              value={query}
              submitLabel="done"
              onInput={value => void setQuery($, value)}
              onSubmit={value =>
                void setQuery($, value)
                  .then(() => update($, search, s => ({ ...s, rev: (s.rev ?? 0) + 1 })))
                  .then(() => (firstMatch ? $.ui.focus({ requestId: PANE, key: firstMatch }) : undefined))
              }
            />
          </Box>
        </Box>
        {error &&<Text color="red">{oneLine(error, 200)}</Text>}
        {checkedAt === 0 && <Text dimColor>Looking for sessions…</Text>}
        {checkedAt > 0 && !q && others.length === 0 && (
          <Text dimColor>{codexActive ? 'No other agent sessions running.' : 'No other Claude Code sessions running.'}</Text>
        )}
        {q && all && allRecent.length > 0 && list.length + recent.length === 0 && (
          <Text dimColor>No session matches “{oneLine(q, 60)}”.</Text>
        )}
        {list.map(s => {
          const index = others.indexOf(s)
          const isBusy = s.status === 'busy'
          return (
            <Box key={s.sessionId} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text wrap="truncate-end">
                  <Text color={isBusy ? 'yellow' : 'green'}>{isBusy ? '●' : '○'} </Text>
                  <Text bold>{s.name}</Text>
                  <Text dimColor>
                    {' '}
                    {s.status} · {ago(s.activeAt, now)}
                    {s.kind !== 'interactive' ? ` · ${s.kind}` : ''}
                    {codexActive ? ` · ${s.tool}` : ''}
                  </Text>
                </Text>
                {s.isSelf ? (
                  <Text dimColor>(this session)</Text>
                ) : (
                  <Button
                    key={`jump-${s.sessionId}`}
                    label={index < 9 ? `${index + 1} Jump` : 'Jump'}
                    hotkey={index < 9 ? String(index + 1) : undefined}
                    variant={index === 0 ? 'primary' : undefined}
                    onPress={press => void jump($, s, press.surface)}
                  />
                )}
              </Box>
              <Text dimColor wrap="truncate-middle">
                {[s.repo, s.branch].filter(Boolean).join(' @ ')}
                {s.repo ? '  ' : ''}
                {s.cwd}
              </Text>
              {s.pr && PrLine({ pr: s.pr, els })}
              {s.title && <Text italic wrap="truncate-end">{s.title}</Text>}
              {s.prompts.map(p => (
                <Text wrap="truncate-end">
                  <Text color="cyan">› </Text>
                  {p}
                </Text>
              ))}
              {s.actions.map(a => (
                <Text dimColor wrap="truncate-end">
                  {'  ⚙ '}
                  {a}
                </Text>
              ))}
            </Box>
          )
        })}
        {all && allRecent.length === 0 && <Text dimColor>Reading session history…</Text>}
        {recent.length > 0 && (
          <Text bold dimColor>
            {q
              ? `Matches · ${recent.length} of ${allRecent.length} past sessions`
              : all ? `History · ${recent.length} sessions` : 'Recent'}
          </Text>
        )}
        {recent.map((r, i) => {
          const key = RECENT_KEYS[i]
          const waiting = isArmed(pending, r.sessionId, now)
          const here = r.cwd === selfCwd
          return (
          <Box key={`recent-${r.sessionId}`} flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between">
              <Text wrap="truncate-end">
                <Text color={waiting ? 'yellow' : undefined} dimColor={!waiting}>{waiting ? '▶ ' : '◦ '}</Text>
                <Text bold>{r.title ?? r.prompts.at(-1) ?? r.sessionId.slice(0, 8)}</Text>
                <Text dimColor>
                  {' '}
                  ended · {ago(r.activeAt, now)} ago
                  {codexActive ? ` · ${r.tool}` : ''}
                </Text>
              </Text>
              <Button
                key={`resume-${r.sessionId}`}
                label={`${key ? `${key} ` : ''}${waiting ? 'Open?' : 'Resume'}`}
                hotkey={key}
                variant={waiting ? 'primary' : undefined}
                onPress={press => void pressResume($, r, key, press.surface)}
              />
            </Box>
            {waiting && (
              <Text color="yellow" wrap="truncate-end">
                {key ? `Press ${key} again` : 'Click again'} to{' '}
                {r.tool === 'codex' && !codexLive
                  ? 'copy the codex resume command (lsof unavailable, it may still be running)'
                  : r.tool !== 'codex' && here
                    ? 'resume it in this window, replacing this conversation'
                    : `open a new terminal running ${r.tool === 'codex' ? 'codex resume' : 'claude --resume'} there`}
              </Text>
            )}
            <Text dimColor wrap="truncate-middle">
              {[r.repo, r.branch].filter(Boolean).join(' @ ')}
              {r.repo ? '  ' : ''}
              {r.cwd}
            </Text>
            {r.pr && PrLine({ pr: r.pr, els })}
            {r.prompts.map(p => (
              <Text dimColor wrap="truncate-end">
                {'› '}
                {p}
              </Text>
            ))}
          </Box>
          )
        })}
      </Box>
    )
  })
}
