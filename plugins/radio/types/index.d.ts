export type NowPlaying = {
  /** Index into STATIONS. */
  index: number
  name: string
  /** mpv changes volume live; ffplay restarts the stream. */
  backend: 'mpv' | 'ffplay'
}

declare module 'claude-code' {
  interface PluginState {
    radio: { now: NowPlaying | null; isBandHidden: boolean }
  }
}
