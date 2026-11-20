import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-hub',
  component: 'Pane',
  requestId: 'session-hub',
  props: {
    title: 'Claude sessions',
    isFocused: true,
    bodyColumns: 100,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const NOW = 1_800_000_000_000
const CLAUDE_SID = '0f05f08d-7356-48ef-b9b4-c18eea1527aa'
const CLAUDE_PATH = `/home/u/.claude/projects/-home-u-infra/${CLAUDE_SID}.jsonl`
const CODEX_SID = '01a1f7f0-b150-7e41-bfc3-88aac140351c'
const CODEX_PATH = `/home/u/.codex/sessions/2026/11/20/rollout-2026-11-20T08-51-48-${CODEX_SID}.jsonl`

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const claudePeek = [
  JSON.stringify({ type: 'ai-title', aiTitle: 'Debug network policy' }),
  JSON.stringify({ type: 'user', cwd: '/home/u/infra', message: { role: 'user', content: 'why is ingress blocked' } }),
].join('\n')

const codexMeta = (threadSource = 'user') =>
  JSON.stringify({
    type: 'session_meta',
    payload: { cwd: '/home/u/api', thread_source: threadSource, source: 'codex-tui', id: CODEX_SID },
  })
const codexUser = (text: string) =>
  JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  })
const codexPeek = [codexMeta(), codexUser('# AGENTS.md instructions for /home/u/api'), codexUser('make the deploy job stable')].join('\n')
const codexIndex = JSON.stringify({ id: CODEX_SID, thread_name: 'Fix flaky deploy', updated_at: '2026-11-20T08:00:00Z' })

type Answers = Partial<Record<'newest' | 'peek' | 'newest-codex' | 'peek-codex' | 'codex-index' | 'lsof-codex' | 'jump.sh', string>>

// Answers $.process.run by the sh -c script's name; `claude agents --json`
// returns no running sessions; git answers nothing useful. `calls` records
// every command's argv joined with spaces; `copied` what reached the clipboard.
function world(on: On, answers: Answers, calls?: string[], copied?: string[], opts?: { cwd?: string; codexDir?: boolean }) {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/u' })
  on('session.cwd', () => ({ value: opts?.cwd ?? '/home/u' }))
  on('session.id', () => ({ value: 'self-sid' }))
  on('fs.exists', (_, e: any) =>
    opts?.codexDir === false && String(e.path).includes('/.codex/') ? { value: false } : { value: true },
  )
  on('fs.stat', () => ({ value: { mtimeMs: NOW - 60_000 } }))
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  if (copied) {
    on('ui.copy', (_, e: any) => {
      copied.push(String(e.text))
      return { value: {} }
    })
  }
  on('process.run', (_, e) => {
    if (calls) calls.push(e.argv.join(' '))
    if (e.argv[0] === 'claude') return ok('[]')
    if (String(e.argv[1]).endsWith('jump.sh')) return ok(answers['jump.sh'] ?? '')
    const name = String(e.argv[3] ?? e.argv[0])
    if (name in answers) return ok(answers[name as keyof Answers]!)
    return ok('')
  })
}

async function openPane($: any) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'sessions', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

test('a recent codex session shows with its index title and a codex tag', async ($, on) => {
  world(on, {
    newest: `1790000000 ${CLAUDE_PATH}\n`,
    peek: claudePeek,
    'newest-codex': `1790001000 ${CODEX_PATH}\n`,
    'peek-codex': codexPeek,
    'codex-index': codexIndex,
  })
  const ui = await openPane($)

  expect(await ui.find({ type: 'Text', text: /Fix flaky deploy/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· codex/ })).toBeDefined()
  expect(await ui.find({ key: `resume-${CODEX_SID}` })).toBeDefined()
  // The Claude row is tagged too once Codex is active on the machine.
  expect(await ui.find({ type: 'Text', text: /Debug network policy/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· claude/ })).toBeDefined()
  // The AGENTS.md harness message was filtered; the real prompt shows.
  expect(await ui.find({ type: 'Text', text: /make the deploy job stable/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /AGENTS\.md/ })).toBeUndefined()
  await ui.unmount()
})

test('a rollout without session_meta is skipped', async ($, on) => {
  world(on, {
    newest: `1790000000 ${CLAUDE_PATH}\n`,
    peek: claudePeek,
    'newest-codex': `1790001000 ${CODEX_PATH}\n`,
    'peek-codex': codexUser('make the deploy job stable'),
    'codex-index': codexIndex,
  })
  const ui = await openPane($)

  expect(await ui.find({ type: 'Text', text: /Debug network policy/ })).toBeDefined()
  expect(await ui.find({ key: `resume-${CODEX_SID}` })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Couldn't read session history/ })).toBeUndefined()
  await ui.unmount()
})

test('a non-user thread_source is excluded', async ($, on) => {
  world(on, {
    newest: `1790000000 ${CLAUDE_PATH}\n`,
    peek: claudePeek,
    'newest-codex': `1790001000 ${CODEX_PATH}\n`,
    'peek-codex': [codexMeta('subtask'), codexUser('make the deploy job stable')].join('\n'),
    'codex-index': codexIndex,
  })
  const ui = await openPane($)

  expect(await ui.find({ type: 'Text', text: /Debug network policy/ })).toBeDefined()
  expect(await ui.find({ key: `resume-${CODEX_SID}` })).toBeUndefined()
  await ui.unmount()
})

test('searching for codex filters to codex rows', async ($, on) => {
  world(on, {
    newest: `1790000000 ${CLAUDE_PATH}\n`,
    peek: claudePeek,
    'newest-codex': `1790001000 ${CODEX_PATH}\n`,
    'peek-codex': codexPeek,
    'codex-index': codexIndex,
  })
  const ui = await openPane($)
  expect(await ui.find({ type: 'Text', text: /Debug network policy/ })).toBeDefined()

  // /sessions bumped the field's rev once, so the Input is keyed search-1.
  await ui.input({ key: 'search-1', text: 'codex', kind: 'change' })
  expect(await ui.find({ key: `resume-${CODEX_SID}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Debug network policy/ })).toBeUndefined()
  await ui.unmount()
})

const lsofRecord = (pid: number, paths: string[]) => [`p${pid}`, 'ccodex', ...paths.map(p => `n${p}`), ''].join('\n')
const CODEX_SID_2 = '02b2f7f0-b150-7e41-bfc3-88aac140351c'
const CODEX_PATH_2 = `/home/u/.codex/sessions/2026/11/20/rollout-2026-11-20T09-00-00-${CODEX_SID_2}.jsonl`
const runningPeek = (task: 'task_started' | 'task_complete') =>
  [codexMeta(), codexUser('make the deploy job stable'), `"type":"${task}"`].join('\n')

test('a running codex session shows busy with a Jump button', async ($, on) => {
  world(on, {
    'lsof-codex': lsofRecord(4242, [CODEX_PATH]),
    'peek-codex': runningPeek('task_started'),
    'codex-index': codexIndex,
  })
  const ui = await openPane($)

  expect(await ui.find({ key: `jump-${CODEX_SID}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /busy/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· codex/ })).toBeDefined()
  // Running, so not offered under Recent too.
  expect(await ui.find({ key: `resume-${CODEX_SID}` })).toBeUndefined()
  await ui.unmount()
})

test('task_complete shows idle', async ($, on) => {
  world(on, {
    'lsof-codex': lsofRecord(4242, [CODEX_PATH]),
    'peek-codex': runningPeek('task_complete'),
  })
  const ui = await openPane($)

  expect(await ui.find({ key: `jump-${CODEX_SID}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /idle/ })).toBeDefined()
  await ui.unmount()
})

test('jump on a shared daemon pid copies cd instead of focusing', async ($, on) => {
  const calls: string[] = []
  const copied: string[] = []
  world(on, {
    'lsof-codex': lsofRecord(4242, [CODEX_PATH, CODEX_PATH_2]),
    'peek-codex': runningPeek('task_started'),
  }, calls, copied)
  const ui = await openPane($)

  await ui.press({ key: `jump-${CODEX_SID}` })
  expect(calls.some(c => c.includes('jump.sh'))).toBe(false)
  expect(copied.length).toBe(1)
  expect(copied[0]!.startsWith('cd ')).toBe(true)
  expect(copied[0]!.includes('/home/u/api')).toBe(true)
  await ui.unmount()
})

test('lsof failure shows no running codex rows and no error', async ($, on) => {
  world(on, {
    'lsof-codex': '',
    newest: `1790000000 ${CLAUDE_PATH}\n`,
    peek: claudePeek,
  })
  const ui = await openPane($)

  expect(await ui.find({ type: 'Text', text: /Debug network policy/ })).toBeDefined()
  expect(await ui.find({ key: `jump-${CODEX_SID}` })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Couldn't read session history/ })).toBeUndefined()
  await ui.unmount()
})

test('resume on a codex recent row arms with codex wording and opens via jump.sh with the codex arg', async ($, on) => {
  const calls: string[] = []
  const copied: string[] = []
  const resumed: string[] = []
  world(on, {
    'newest-codex': `1790001000 ${CODEX_PATH}\n`,
    'peek-codex': codexPeek,
    'codex-index': codexIndex,
  }, calls, copied, { cwd: '/home/u/api' }) // the codex session's own folder
  on('command.run', (_, e: any) => {
    if (e.command === 'resume') resumed.push(String(e.args))
    return { value: {} }
  })
  const ui = await openPane($)

  await ui.press({ key: `resume-${CODEX_SID}` })
  expect(await ui.find({ type: 'Text', text: /codex resume/ })).toBeDefined()

  await ui.press({ key: `resume-${CODEX_SID}` })
  // Even from the session's own folder, a codex row never resumes in place.
  expect(resumed.length).toBe(0)
  const jumpCall = calls.find(c => c.includes('jump.sh'))
  expect(jumpCall).toBeDefined()
  expect(jumpCall!.endsWith(`0 resume ${CODEX_SID} /home/u/api codex`)).toBe(true)
  // jump.sh answered nothing, so the command was copied instead.
  expect(copied[0]).toBe(`cd "/home/u/api" && codex resume ${CODEX_SID}`)
  await ui.unmount()
})

test('a missing codex dir runs no codex commands and hides tags', async ($, on) => {
  const calls: string[] = []
  world(on, {
    newest: `1790000000 ${CLAUDE_PATH}\n`,
    peek: claudePeek,
  }, calls, undefined, { codexDir: false })
  const ui = await openPane($)

  expect(await ui.find({ type: 'Text', text: /Debug network policy/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· claude/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /· codex/ })).toBeUndefined()
  for (const name of ['lsof-codex', 'newest-codex', 'peek-codex', 'codex-index']) {
    expect(calls.some(c => c.includes(name))).toBe(false)
  }
  await ui.unmount()
})

test('the same rollout open on two file descriptors is one focusable row', async ($, on) => {
  const calls: string[] = []
  const copied: string[] = []
  // lsof reports one n line per descriptor; the pid is NOT really shared.
  world(on, {
    'lsof-codex': lsofRecord(4242, [CODEX_PATH, CODEX_PATH]),
    'peek-codex': runningPeek('task_started'),
    'jump.sh': 'focused iTerm2',
  }, calls, copied)
  const ui = await openPane($)

  await ui.press({ key: `jump-${CODEX_SID}` })
  expect(calls.some(c => c.includes('jump.sh'))).toBe(true)
  expect(copied.length).toBe(0)
  await ui.unmount()
})
