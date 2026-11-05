/** The newest pull request opened from a session's branch, as `gh` reports it. */
export type PrInfo = {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  /** Rolled up from the PR's checks; absent when it has none. */
  checks?: 'pass' | 'fail' | 'pending'
  /** GitHub's review decision; absent when no review is required or given. */
  review?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'
}

export type SessionInfo = {
  sessionId: string
  pid: number
  name: string
  title?: string
  cwd: string
  repo?: string
  branch?: string
  kind: string
  status: string
  isSelf: boolean
  prompts: string[]
  actions: string[]
  activeAt: number
  pr?: PrInfo
}

/** A session that is no longer running, read from its transcript. */
export type RecentInfo = {
  sessionId: string
  title?: string
  cwd: string
  repo?: string
  branch?: string
  prompts: string[]
  /** Every prompt read from the transcript (its last 25), for search; `prompts` is what is shown. */
  allPrompts?: string[]
  activeAt: number
  pr?: PrInfo
}

export type Snapshot = {
  list: SessionInfo[]
  recent: RecentInfo[]
  /** Set by `/sessions -a`: `recent` holds every past session, not just the newest few. */
  all?: boolean
  error?: string
  checkedAt: number
}

/** What the search field holds; `auto` when typing it switched to the full history. */
export type Search = {
  query: string
  auto?: boolean
  /** Bumped on Enter: a field submits empty, so a new key draws the text again. */
  rev?: number
}

/**
 * The Recent row whose Resume was pressed once and waits for a second press
 * to really open a terminal; `sessionId` absent when none is waiting.
 */
export type Armed = {
  sessionId?: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'claude-session-hub': { snapshot: Shaped<Snapshot>; armed: Shaped<Armed>; search: Shaped<Search> }
  }
}
