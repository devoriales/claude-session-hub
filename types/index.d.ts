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
}

export type Snapshot = {
  list: SessionInfo[]
  error?: string
  checkedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-hub': { snapshot: Shaped<Snapshot> }
  }
}
