import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SessionInfo, Snapshot } from '../types'

const PANE = 'session-hub'
const TITLE = 'Claude sessions'
const POLL_MS = 5000
const GIT_TTL_MS = 30000

// Change the shape tag whenever SessionInfo / Snapshot change: it declines
// what an earlier version stored, which outlives a reload.
const snapshot = atom(
  { plugin: 'session-hub', key: 'snapshot' } as const,
  { list: [], checkedAt: 0 },
  { shape: 'snapshot-1' },
)

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
  prompts: string[]
  actions: string[]
}

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

const describeTool = (name: string, input: Record<string, unknown>) => {
  const pick = ['description', 'command', 'file_path', 'pattern', 'url', 'query', 'skill', 'prompt']
    .map(k => input[k])
    .find(v => typeof v === 'string' && v.length > 0) as string | undefined
  const short = name.replace(/^mcp__([^_]+)__/, '$1:')
  return pick ? `${short}: ${oneLine(pick, 70)}` : short
}

const parseTranscript = (stdout: string): Omit<TranscriptInfo, 'mtimeMs'> => {
  let title: string | undefined
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
    if (row.type === 'user' && !row.isMeta && !row.isCompactSummary && typeof row.message?.content === 'string') {
      const text: string = row.message.content
      if (/^(<|\[Request interrupted|This session is being continued)/.test(text)) continue
      const flat = oneLine(text, 90)
      if (flat && prompts.at(-1) !== flat) prompts.push(flat)
    }
    if (row.type === 'assistant' && Array.isArray(row.message?.content)) {
      for (const block of row.message.content) {
        if (block?.type === 'tool_use') actions.push(describeTool(block.name, block.input ?? {}))
      }
    }
  }

  return { title, prompts: prompts.slice(-3), actions: actions.slice(-3) }
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

async function refresh($: EngineInterface) {
  if (ticking) return
  ticking = true
  try {
    const now: number = await $.clock.now()
    const selfId: string = await $.session.id()
    const home = await $.env.get('HOME')
    const base = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`

    const res = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: 15000 })
    if (res.exitCode !== 0) throw new Error(oneLine(res.stderr || 'claude agents --json failed', 200))
    const rows: AgentRow[] = JSON.parse(res.stdout)

    const list: SessionInfo[] = []
    for (const row of rows) {
      let info: TranscriptInfo = { mtimeMs: row.startedAt, prompts: [], actions: [] }
      const path = await transcriptPath($, base, row.cwd, row.sessionId).catch(() => undefined)
      if (path) {
        const { mtimeMs } = await $.fs.stat(path)
        const cached = transcripts.get(row.sessionId)
        if (cached && cached.mtimeMs === mtimeMs) {
          info = cached
        } else {
          const peek = await $.process.run(['sh', '-c', PEEK, 'peek', path], { timeoutMs: 10000 })
          info = { mtimeMs, ...parseTranscript(peek.stdout) }
          transcripts.set(row.sessionId, info)
        }
      }
      const { repo, branch } = await gitInfo($, row.cwd, now)

      list.push({
        sessionId: row.sessionId,
        pid: row.pid,
        name: row.name ?? row.sessionId.slice(0, 8),
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
      })
    }

    // Busy first, then most recently active; this session last.
    list.sort(
      (a, b) =>
        Number(a.isSelf) - Number(b.isSelf) ||
        Number(b.status === 'busy') - Number(a.status === 'busy') ||
        b.activeAt - a.activeAt,
    )
    await update($, snapshot, () => ({ list, checkedAt: now }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await update($, snapshot, s => ({ ...s, error: message }))
  } finally {
    ticking = false
  }
}

async function jump($: EngineInterface, s: SessionInfo, surface: any) {
  const root: string = $.plugin.root
  const cwd = s.cwd.startsWith('~') ? `${await $.env.get('HOME')}${s.cwd.slice(1)}` : s.cwd
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


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sessions',
      description: 'Show every running Claude Code session in a pane',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    timer?.cancel()
    timer = $.clock.every(POLL_MS, async () => {
      // Only poll while the pane is actually up.
      const panes = await $.ui.panes()
      if (panes.some(p => p.id === PANE && p.isPlaced)) await refresh($)
    })

    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    await refresh($)

    return { text: 'Sessions pane opened. Press a number (or click Jump) to switch.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { list, error, checkedAt } = await read($, snapshot)
    const now = await $.clock.now()
    const others = list.filter(s => !s.isSelf)

    return (
      <Box flexDirection="column" gap={1}>
        {error && <Text color="red">{oneLine(error, 200)}</Text>}
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
      </Box>
    )
  })
}
