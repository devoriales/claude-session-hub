import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Armed, PrInfo, RecentInfo, SessionInfo, Snapshot } from '../types'

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
const RECENT_MAX = 8
// `/sessions -a` lists every past session; only the newest few get a PR lookup,
// since `gh` goes to the network.
const HISTORY_PR_MAX = RECENT_MAX
// Hotkeys for the Recent rows; digits belong to the running sessions' Jump.
const RECENT_KEYS = 'abcdefgh'
// `/sessions close` (or off / hide) closes the pane from the prompt.
const CLOSE_ARGS = new Set(['close', 'off', 'hide'])
const HELP_ARGS = new Set(['help', '-h', '--help'])
const USAGE = [
  'Usage: /sessions [-a | close | help]',
  '  /sessions          open the pane: running sessions and the 8 most recent ones',
  '  /sessions -a       list every past session (also --all)',
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
  { shape: 'snapshot-4' },
)

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
  prompts: string[]
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

  return { title, cwd, branch, automated, prompts: prompts.slice(-3), actions: actions.slice(-3) }
}

const SESSION_FILE = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

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
async function readTranscript($: EngineInterface, sid: string, path: string, mtimeMs: number) {
  const cached = transcripts.get(sid)
  if (cached && cached.mtimeMs === mtimeMs) return cached
  const peek = await $.process.run(['sh', '-c', PEEK, 'peek', path], { timeoutMs: 10000 })
  const info: TranscriptInfo = { mtimeMs, ...parseTranscript(peek.stdout) }
  transcripts.set(sid, info)
  return info
}

// The newest sessions that are not running, with at least one prompt; every
// such session when `all` is set. Transcripts are read BATCH at a time, and
// `progress` gets the rows found so far after each batch, so a first `-a` over
// hundreds of transcripts fills the pane as it goes instead of all at the end.
const BATCH = 8

async function recentSessions(
  $: EngineInterface,
  base: string,
  running: Set<string>,
  home: string | undefined,
  now: number,
  all: boolean,
  progress?: (rows: RecentInfo[]) => Promise<unknown>,
) {
  const res = await $.process.run(['sh', '-c', NEWEST, 'newest', base, all ? '0' : '60'], {
    timeoutMs: all ? 30000 : 10000,
  })
  const files = res.stdout.split('\n').flatMap(line => {
    const space = line.indexOf(' ')
    const path = line.slice(space + 1)
    const sid = SESSION_FILE.exec(path)?.[1]
    if (space < 0 || !sid || running.has(sid)) return []
    return [{ sid, path, mtimeMs: Math.round(Number(line.slice(0, space)) * 1000) }]
  })

  const toRow = async ({ sid, path, mtimeMs }: (typeof files)[number]) => {
    const info = await readTranscript($, sid, path, mtimeMs).catch(() => undefined)
    if (!info?.cwd || info.automated || info.prompts.length === 0) return undefined
    const { repo } = await gitInfo($, info.cwd, now)
    const item: RecentInfo = {
      sessionId: sid,
      title: info.title,
      cwd: tilde(info.cwd, home),
      repo,
      branch: info.branch,
      prompts: info.prompts.slice(all ? -1 : -2),
      activeAt: mtimeMs,
    }
    return { item, cwd: info.cwd, branch: info.branch }
  }

  const found: NonNullable<Awaited<ReturnType<typeof toRow>>>[] = []
  for (let i = 0; i < files.length; i += BATCH) {
    if (!all && found.length >= RECENT_MAX) break
    const rows = await Promise.all(files.slice(i, i + BATCH).map(toRow))
    for (const row of rows) if (row) found.push(row)
    if (all && progress) await progress(found.map(r => r.item))
  }
  const top = found.slice(0, all ? found.length : RECENT_MAX)

  await Promise.all(
    top.slice(0, HISTORY_PR_MAX).map(r => prInfo($, r.cwd, r.branch, now).then(pr => void (r.item.pr = pr))),
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
        prompts: info.prompts,
        actions: info.actions,
        activeAt: info.mtimeMs,
      }
      list.push(item)
      prJobs.push(prInfo($, row.cwd, branch, now).then(pr => void (item.pr = pr)))
    }

    // Busy first, then most recently active; this session last.
    list.sort(
      (a, b) =>
        Number(a.isSelf) - Number(b.isSelf) ||
        Number(b.status === 'busy') - Number(a.status === 'busy') ||
        b.activeAt - a.activeAt,
    )
    const running = new Set(rows.map(r => r.sessionId))
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
    const recent = await recentSessions($, base, running, home, now, all, progress).catch(error => {
      historyError = `Couldn't read session history: ${error instanceof Error ? error.message : String(error)}`
      return [] as RecentInfo[]
    })
    await Promise.all(prJobs)
    // If the mode flipped while this ran, keep the newer choice; the next tick fills it in.
    await update($, snapshot, s =>
      (s.all ?? false) === all
        ? { list, recent, all, checkedAt: now, error: historyError }
        : { ...s, list, checkedAt: now, error: historyError },
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
  const res = await $.process
    .run(['sh', `${root}/bin/jump.sh`, String(s.pid), s.kind, s.sessionId, cwd], { timeoutMs: 15000 })
    .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  const [verdict, ...rest] = res.stdout.trim().split(' ')
  const how = rest.join(' ')

  if (verdict === 'focused') return $.ui.toast(`Switched to ${s.name} (${how})`)
  if (verdict === 'opened') return $.ui.toast(`Opened ${s.name} in a new ${how} window`)

  const command = s.kind === 'interactive' ? `cd ${JSON.stringify(cwd)}` : `claude attach ${s.sessionId}`
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
  const where = (await isHere($, r)) ? 'here, replacing this conversation' : `(${r.cwd}) in a new terminal`
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
  if (await isHere($, r)) {
    const ran = await $.command
      .run({ command: 'resume', args: r.sessionId })
      .then(() => true, () => false)
    if (ran) return
    // Fall through to a new terminal if /resume was refused.
  }
  const res = await $.process
    .run(['sh', `${$.plugin.root}/bin/jump.sh`, '0', 'resume', r.sessionId, cwd], { timeoutMs: 15000 })
    .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  const [verdict, ...rest] = res.stdout.trim().split(' ')
  if (verdict === 'opened') return $.ui.toast(`Resumed ${label} in a new ${rest.join(' ')} window`)

  const command = `cd ${JSON.stringify(cwd)} && claude --resume ${r.sessionId}`
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
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

  on('command.run', { command: 'sessions' }, async ($, e) => {
    const flags = e.args.trim().split(/\s+/).filter(Boolean)
    if (flags.length === 1 && HELP_ARGS.has(flags[0]!)) return { text: USAGE }
    if (flags.length === 1 && CLOSE_ARGS.has(flags[0]!)) {
      const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
      if (!isOpen) return { text: 'The sessions pane is not open.' }
      await $.ui.close({ id: PANE })
      return { text: 'Sessions pane closed. /sessions opens it again.' }
    }
    const unknown = flags.filter(f => f !== '-a' && f !== '--all')
    if (unknown.length > 0) return { text: `Unknown option ${unknown.join(' ')}.\n${USAGE}` }
    const all = flags.length > 0
    // Switching modes empties the list below the running sessions until it is read again.
    await update($, snapshot, s => ((s.all ?? false) === all ? s : { ...s, all, recent: [] }))
    await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true, rows: PANE_ROWS, columns: PANE_COLUMNS })
    // Reading every transcript the first time can take a while, so don't hold the
    // command; a tick already under way skips this one and the 5 s poll catches up.
    void refresh($)

    return {
      text: all
        ? 'Sessions pane opened with every past session. Press a–h or click Resume to reopen one; arrows scroll. /sessions shows recent only again. x or Esc closes it.'
        : 'Sessions pane opened. Press a number (or click Jump) to switch; x or Esc closes it.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const els = { Box, Text, Link }
    const { list, recent = [], all = false, error, checkedAt } = await read($, snapshot)
    const pending = await read($, armed)
    const now = await $.clock.now()
    const others = list.filter(s => !s.isSelf)
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
      </Box>
    ) : (
      <Text>
        <Text color={NEON[0]} bold>▓▒░ CLAUDE </Text>
        <Text color={NEON[2]} bold>SESSION HUB ░▒▓</Text>
        <Text dimColor> devoriales</Text>
      </Text>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start">
          {banner}
          <Button label="x Close" hotkey="x" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
        {error &&<Text color="red">{oneLine(error, 200)}</Text>}
        {checkedAt === 0 && <Text dimColor>Looking for sessions…</Text>}
        {checkedAt > 0 && others.length === 0 && <Text dimColor>No other Claude Code sessions running.</Text>}
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
        {all && recent.length === 0 && <Text dimColor>Reading session history…</Text>}
        {recent.length > 0 && (
          <Text bold dimColor>
            {all ? `History · ${recent.length} sessions` : 'Recent'}
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
                <Text dimColor> ended · {ago(r.activeAt, now)} ago</Text>
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
                {here ? 'resume it in this window, replacing this conversation' : 'open a new terminal running claude --resume there'}
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
