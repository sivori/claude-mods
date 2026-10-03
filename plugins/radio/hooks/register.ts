import type { EngineInterface, Register } from 'claude-code'

export type Station = { name: string; url: string; genre: string }

// Lo-fi, SomaFM, and a few public-radio streams.
export const STATIONS: Station[] = [
  { name: 'Lofi Girl', url: 'https://play.streamafrica.net/lofiradio', genre: 'lo-fi' },
  { name: 'Chillhop', url: 'https://streams.fluxfm.de/Chillhop/mp3-320/audio/', genre: 'lo-fi' },
  { name: 'SomaFM Secret Agent', url: 'https://ice1.somafm.com/secretagent-128-mp3', genre: 'chill jazz' },
  { name: 'SomaFM Sonic Universe', url: 'https://ice1.somafm.com/sonicuniverse-128-mp3', genre: 'jazz' },
  { name: 'SomaFM Groove Salad', url: 'https://ice1.somafm.com/groovesalad-256-mp3', genre: 'ambient' },
  { name: 'SomaFM DEF CON', url: 'https://ice1.somafm.com/defcon-256-mp3', genre: 'synth' },
  { name: 'SomaFM Drone Zone', url: 'https://ice1.somafm.com/dronezone-256-mp3', genre: 'drone' },
  { name: 'SomaFM Space Station', url: 'https://ice1.somafm.com/spacestation-128-mp3', genre: 'ambient' },
  { name: 'SomaFM Vaporwaves', url: 'https://ice1.somafm.com/vaporwaves-128-mp3', genre: 'vapor' },
  { name: 'SomaFM cliqhop idm', url: 'https://ice1.somafm.com/cliqhop-256-mp3', genre: 'idm' },
  { name: 'SomaFM Deep Space One', url: 'https://ice1.somafm.com/deepspaceone-128-mp3', genre: 'deep' },
  { name: 'SomaFM Beat Blender', url: 'https://ice1.somafm.com/beatblender-128-mp3', genre: 'beats' },
  { name: 'WWFM Classical', url: 'https://wwfm.streamguys1.com/live', genre: 'classical' },
  { name: 'Classical Choral', url: 'https://choral.stream.publicradio.org/choral.aac', genre: 'choral' },
]

export type Action =
  | { kind: 'toggle' | 'stop' | 'next' | 'prev' | 'list' }
  | { kind: 'volume'; value: number; isRelative: boolean }
  | { kind: 'play'; index: number }
  | { kind: 'unknown'; query: string }

/** `/radio` arguments → what to do. Names match on any substring of name or genre. */
export function parse(args: string, stations: readonly Station[] = STATIONS): Action {
  const text = args.trim().toLowerCase()
  if (text === '' || text === 'play' || text === 'toggle') return { kind: 'toggle' }
  if (['stop', 'off', 'pause', 'quiet'].includes(text)) return { kind: 'stop' }
  if (text === 'next' || text === 'n') return { kind: 'next' }
  if (text === 'prev' || text === 'p') return { kind: 'prev' }
  if (text === 'list' || text === 'ls') return { kind: 'list' }

  const vol = /^vol(?:ume)?\s+([+-]?)(\d+)$/.exec(text)
  if (vol) return { kind: 'volume', value: (vol[1] === '-' ? -1 : 1) * Number(vol[2]), isRelative: vol[1] !== '' }

  if (/^\d+$/.test(text)) {
    const index = Number(text) - 1
    return index >= 0 && index < stations.length ? { kind: 'play', index } : { kind: 'unknown', query: text }
  }

  const query = text.replace(/^play\s+/, '')
  const index = stations.findIndex(s => s.name.toLowerCase().includes(query))
  const byGenre = stations.findIndex(s => s.genre.toLowerCase().includes(query))
  const found = index >= 0 ? index : byGenre
  return found >= 0 ? { kind: 'play', index: found } : { kind: 'unknown', query }
}

export function listing(current: number, isPlaying: boolean, volume: number): string {
  const rows = STATIONS.map((s, i) => `${i === current ? (isPlaying ? '▶' : '·') : ' '} ${String(i + 1).padStart(2)}. ${s.name}  (${s.genre})`)
  return [...rows, '', `volume ${volume} · /radio <n|name|genre> · next · prev · stop · vol [+-]N`].join('\n')
}

/** `i` is always reduced modulo the list before it gets here. */
const stationAt = (i: number): Station => STATIONS[i] as Station

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)))

// One player per machine, shared by every Claude session: a detached ffplay
// whose pid and station live in ~/.cache/claude-radio/now. Any session's
// /radio replaces it rather than starting a second stream, and any session's
// stop ends it. A pid is only killed while `ps` still names it ffplay, so a
// recycled pid is never touched.
export const CTL = `
dir="$HOME/.cache/claude-radio"; f="$dir/now"
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
alive() { [ -f "$f" ] && read -r opid oidx < "$f" && ps -p "$opid" -o comm= 2>/dev/null | grep -q ffplay; }
case "$1" in
  status) if alive; then echo "$oidx"; else rm -f "$f"; fi ;;
  stop) if alive; then kill -9 "$opid"; fi; rm -f "$f" ;;
  play)
    idx="$2"; shift 2
    command -v ffplay >/dev/null || { echo "ffplay not found" >&2; exit 127; }
    if alive; then kill -9 "$opid"; fi
    mkdir -p "$dir"
    nohup ffplay "$@" </dev/null >/dev/null 2>&1 &
    echo "$! $idx" > "$f" ;;
esac
`

// Module-scope on purpose: a reload re-runs this file and re-reads the
// shared player, so starting over loses nothing.
let index = 0
let volume = 50
/** The shared player's station as this session last saw it; null = silent. */
let playing: number | null = null
/** Whether this session started the current stream (only it toasts a drop). */
let isOwner = false

async function ctl($: EngineInterface, args: readonly string[]) {
  return $.process.run(['/bin/sh', '-c', CTL, 'radio', ...args])
}

function show($: EngineInterface) {
  $.ui.status(playing === null ? undefined : `♪ ${stationAt(playing).name}`)
}

/** Re-read the shared player; another session may have switched or stopped it. */
async function sync($: EngineInterface) {
  const { stdout } = await ctl($, ['status'])
  const now = /^\d+$/.test(stdout.trim()) ? Number(stdout.trim()) % STATIONS.length : null
  if (now === playing) return
  if (now === null && isOwner && playing !== null) $.ui.toast(`Radio dropped: ${stationAt(playing).name}`)
  if (now !== null) index = now
  playing = now
  isOwner = false
  show($)
}

async function stop($: EngineInterface) {
  await ctl($, ['stop'])
  playing = null
  isOwner = false
  show($)
}

/** Starts `next` on the shared player; resolves to an error line, or undefined. */
async function play($: EngineInterface, next: number): Promise<string | undefined> {
  index = (next + STATIONS.length) % STATIONS.length
  await $.store.set('index', index)
  const result = await ctl($, ['play', String(index), '-nodisp', '-vn', '-nostats', '-loglevel', 'error',
    '-volume', String(volume), '-infbuf', stationAt(index).url])
  if (result.exitCode !== 0) {
    playing = null
    show($)
    return result.exitCode === 127 ? 'ffplay not found — brew install ffmpeg' : result.stderr.trim() || `exit ${result.exitCode}`
  }
  playing = index
  isOwner = true
  show($)
  return undefined
}

async function playReply($: EngineInterface, next: number) {
  const error = await play($, next)
  return { text: error ?? `♪ ${stationAt(index).name}` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    index = Number((await $.store.get('index')) ?? 0) % STATIONS.length
    volume = clamp(Number((await $.store.get('volume')) ?? 50))
    await $.command.register({
      name: 'radio',
      description: 'Stream internet radio (SomaFM, lo-fi, classical…), shared across sessions',
      argumentHint: '[n|name|genre|next|prev|stop|list|vol N]',
      immediate: true,
    })
    await sync($)
    $.clock.every(10_000, () => sync($))
    return started
  })

  on('command.run', { command: 'radio' }, async ($, e) => {
    await sync($)
    const action = parse(e.args)
    switch (action.kind) {
      case 'toggle':
        if (playing !== null) {
          await stop($)
          return { text: 'Radio off.' }
        }
        return playReply($, index)
      case 'stop':
        await stop($)
        return { text: 'Radio off.' }
      case 'next':
      case 'prev':
      case 'play':
        return playReply($, action.kind === 'play' ? action.index : index + (action.kind === 'next' ? 1 : -1))
      case 'list':
        return { text: listing(index, playing !== null, volume) }
      case 'volume':
        volume = clamp(action.isRelative ? volume + action.value : action.value)
        await $.store.set('volume', volume)
        // ffplay has no runtime volume control, so restart the stream
        if (playing !== null) {
          const error = await play($, index)
          if (error) return { text: error }
        }
        return { text: `Volume ${volume}` }
      case 'unknown':
        return { text: `No station matches "${action.query}".\n\n${listing(index, playing !== null, volume)}` }
    }
  })
}
