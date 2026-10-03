export type Mood = 'calm' | 'overcast' | 'storm'

export type Painting = {
  /** Absolute path of the cached PNG the terminal draws. */
  file: string
  title: string
  artist: string
  date: string
  /** Pixel size of the PNG, for sizing the Image box. */
  width: number
  height: number
  /** The mood it was chosen for. */
  mood: Mood
}

declare module 'claude-code' {
  interface PluginState {
    'commonplace-pane': { painting: Painting | null; mood: Mood }
  }
}
