export type Backlog = {
  /** Absolute path of the BACKLOG.md this band reads. */
  path: string
  /** The project folder's name, shown as the band's label. */
  project: string
  /** Open items under `## Now`, text only. */
  now: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'backlog-band': { backlog: Backlog | null; isHidden: boolean }
  }
}
