export type Recap = {
  /** The session the recap is of. */
  sessionId: string
  /** The repo (or session folder) it was written for. */
  root: string
  /** The folder's name, shown as the band's label. */
  project: string
  /** Epoch ms of the session's start, and of its last saved activity. */
  startedAt: number
  updatedAt: number
  /** The person's prompts, first line of each, oldest first. */
  prompts: string[]
  /** Files edited, relative to `root`. */
  files: string[]
  /** Subjects of the commits made since the session started. */
  commits: string[]
  /** The model's one-line summary and next step, once written. */
  done?: string
  next?: string
}

declare module 'claude-code' {
  interface PluginState {
    'day-recap': { previous: Recap | null; isShown: boolean }
  }
}
