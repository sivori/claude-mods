export type NowPlaying = {
  /** Index into STATIONS. */
  index: number
  name: string
  /** mpv changes volume live; ffplay restarts the stream. */
  backend: 'mpv' | 'ffplay'
}

/** The station last heard this session: what a stopped band offers to resume. */
export type LastStation = { index: number; name: string }

declare module 'claude-code' {
  interface PluginState {
    radio: { now: NowPlaying | null; isBandHidden: boolean; lastStation: LastStation | null }
  }
}
