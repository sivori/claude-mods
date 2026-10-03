export type QuestKind = 'todo' | 'issue' | 'test'

export type Quest = {
  /** Stable within a day: `todo:<file>:<text>`, `issue:<n>`, `test:<command>`. */
  id: string
  kind: QuestKind
  /** What the board shows. */
  title: string
  /** Where it lives: `file:line`, `#42`, or the test command. */
  where: string
  /** The TODO line's trimmed text, matched to tell when it is gone. */
  needle?: string
  isDone: boolean
}

export type Board = {
  /** The local day the quests were drawn for, `YYYY-MM-DD`. */
  day: string
  root: string
  project: string
  quests: Quest[]
}

declare module 'claude-code' {
  interface PluginState {
    'quest-board': { board: Board | null }
  }
}
