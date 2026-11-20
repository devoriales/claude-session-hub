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

type Answers = Partial<Record<'newest' | 'peek' | 'newest-codex' | 'peek-codex' | 'codex-index' | 'lsof-codex', string>>

// Answers $.process.run by the sh -c script's name; `claude agents --json`
// returns no running sessions; git answers nothing useful.
function world(on: On, answers: Answers, calls?: string[]) {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/u' })
  on('session.cwd', () => ({ value: '/home/u' }))
  on('session.id', () => ({ value: 'self-sid' }))
  on('fs.exists', () => ({ value: true }))
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'claude') return ok('[]')
    const name = String(e.argv[3] ?? e.argv[0])
    if (calls) calls.push(name)
    if (name in answers) return ok(answers[name as keyof Answers]!)
    if (name === 'newest' || name === 'newest-codex' || name === 'lsof-codex' || name === 'codex-index') return ok('')
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
