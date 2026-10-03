import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NowPlaying } from '../types'

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
  | { kind: 'toggle' | 'stop' | 'next' | 'prev' | 'list' | 'band' }
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
  if (text === 'band') return { kind: 'band' }

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
  return [...rows, '', `volume ${volume} · /radio <n|name|genre> · next · prev · stop · vol [+-]N · band`].join('\n')
}

/** `i` is always reduced modulo the list before it gets here. */
const stationAt = (i: number): Station => STATIONS[i] as Station

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)))

// One player per machine, shared by every Claude session: a detached mpv (or
// ffplay) whose pid, station and backend live in ~/.cache/claude-radio/now.
// Any session's /radio replaces it rather than starting a second stream, and
// any session's stop ends it. A pid is only killed while `ps` still names it
// a player, so a recycled pid is never touched.
//
// mpv takes volume changes live over its IPC socket; ffplay has no runtime
// control, so `vol` exits 3 and the caller restarts the stream instead.
//
// Each session touches sessions/<id> on every sync. With stopWithLastSession
// on, a watchdog beside the player ends it once no lease is under a minute
// old, so even a crashed last session doesn't leave music playing.
export const CTL = `
dir="$HOME/.cache/claude-radio"; f="$dir/now"; leases="$dir/sessions"; sock="$dir/mpv.sock"
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
# A file written by radio 0.1 has no backend field: read it off the process.
alive() { [ -f "$f" ] && read -r opid oidx obk < "$f" && c=$(ps -p "$opid" -o comm= 2>/dev/null) && echo "$c" | grep -qE 'ffplay|mpv' && { [ -n "$obk" ] || obk=$(basename "$c"); }; }
fresh() { [ -n "$(find "$leases" -type f -mmin -1 2>/dev/null | head -1)" ]; }
case "$1" in
  status)
    [ -n "$2" ] && mkdir -p "$leases" && touch "$leases/$2"
    find "$leases" -type f -mmin +1440 -delete 2>/dev/null
    if alive; then echo "$oidx $obk"; else rm -f "$f"; fi ;;
  leave)
    rm -f "$leases/$2"
    if [ "$3" = 1 ] && ! fresh && alive; then kill -9 "$opid"; rm -f "$f"; fi ;;
  stop) if alive; then kill -9 "$opid"; fi; rm -f "$f" ;;
  vol)
    alive && [ "$obk" = mpv ] && printf '{"command":["set_property","volume",%s]}\\n' "$2" | nc -U -w 1 "$sock" >/dev/null 2>&1 && exit 0
    exit 3 ;;
  play)
    idx="$2"; url="$3"; vol="$4"; watch="$5"
    if alive; then kill -9 "$opid"; fi
    mkdir -p "$dir" "$leases"
    if command -v mpv >/dev/null; then
      rm -f "$sock"; bk=mpv
      nohup mpv --no-video --no-terminal --volume="$vol" --input-ipc-server="$sock" "$url" </dev/null >/dev/null 2>&1 &
    elif command -v ffplay >/dev/null; then
      bk=ffplay
      nohup ffplay -nodisp -vn -nostats -loglevel error -volume "$vol" -infbuf "$url" </dev/null >/dev/null 2>&1 &
    else
      echo "no player" >&2; exit 127
    fi
    pid=$!; echo "$pid $idx $bk" > "$f"
    if [ "$watch" = 1 ]; then
      nohup sh -c 'while kill -0 "$1" 2>/dev/null; do sleep 15; [ -n "$(find "$2" -type f -mmin -1 2>/dev/null | head -1)" ] || { kill -9 "$1"; rm -f "$3"; break; }; done' watchdog "$pid" "$leases" "$f" </dev/null >/dev/null 2>&1 &
    fi ;;
esac
`

/** What `status` printed: the station and backend, or null when silent. */
export function parseStatus(stdout: string): NowPlaying | null {
  const match = /^(\d+)\s+(mpv|ffplay)/.exec(stdout.trim())
  if (!match) return null
  const index = Number(match[1]) % STATIONS.length
  return { index, name: stationAt(index).name, backend: match[2] as NowPlaying['backend'] }
}

// What the band draws; the status line and /radio read the same value.
const nowPlaying = atom({ plugin: 'radio', key: 'now' } as const, null)
const isBandHidden = atom({ plugin: 'radio', key: 'isBandHidden' } as const, false)

// Module-scope on purpose: a reload re-runs this file and re-reads the
// shared player, so starting over loses nothing.
let index = 0
let volume = 50
let sessionId = ''
let stopWithLastSession = false
/** Whether this session started the current stream (only it toasts a drop). */
let isOwner = false

async function ctl($: EngineInterface, args: readonly string[]) {
  return $.process.run(['/bin/sh', '-c', CTL, 'radio', ...args])
}

async function publish($: EngineInterface, now: NowPlaying | null) {
  await update($, nowPlaying, () => now)
  $.ui.status(now === null ? undefined : `♪ ${now.name}`)
}

/** Re-read the shared player; another session may have switched or stopped it. */
async function sync($: EngineInterface) {
  const { stdout } = await ctl($, ['status', sessionId])
  const now = parseStatus(stdout)
  const was = await read($, nowPlaying)
  // Another session may have changed the volume; the band shows it.
  const stored = clamp(Number((await $.store.get('volume')) ?? volume))
  const isVolumeNew = stored !== volume
  volume = stored
  if (now?.index === was?.index && now?.backend === was?.backend) {
    if (isVolumeNew) await redraw($)
    return
  }
  if (now === null && isOwner && was !== null) $.ui.toast(`Radio dropped: ${was.name}`)
  if (now !== null) index = now.index
  isOwner = false
  await publish($, now)
}

async function stop($: EngineInterface) {
  await ctl($, ['stop'])
  isOwner = false
  await publish($, null)
}

/** Starts `next` on the shared player; resolves to an error line, or undefined. */
async function play($: EngineInterface, next: number): Promise<string | undefined> {
  index = (next + STATIONS.length) % STATIONS.length
  await $.store.set('index', index)
  const result = await ctl($, ['play', String(index), stationAt(index).url, String(volume), stopWithLastSession ? '1' : '0'])
  if (result.exitCode !== 0) {
    await publish($, null)
    return result.exitCode === 127 ? 'No player found — brew install mpv (or ffmpeg)' : result.stderr.trim() || `exit ${result.exitCode}`
  }
  isOwner = true
  await sync($)
  return undefined
}

async function playReply($: EngineInterface, next: number) {
  const error = await play($, next)
  return { text: error ?? `♪ ${stationAt(index).name}` }
}

/** Applies `volume` to the running player: live on mpv, a restart on ffplay. */
async function applyVolume($: EngineInterface) {
  await $.store.set('volume', volume)
  if ((await read($, nowPlaying)) === null) return undefined
  const live = await ctl($, ['vol', String(volume)])
  return live.exitCode === 0 ? undefined : play($, index)
}

export const register: Register = (on, options) => {
  stopWithLastSession = options.stopWithLastSession === true

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    index = Number((await $.store.get('index')) ?? 0) % STATIONS.length
    volume = clamp(Number((await $.store.get('volume')) ?? 50))
    sessionId = await $.session.id()
    await $.command.register({
      name: 'radio',
      description: 'Stream internet radio (SomaFM, lo-fi, classical…), shared across sessions',
      argumentHint: '[n|name|genre|next|prev|stop|list|vol N|band]',
      immediate: true,
    })
    await sync($)
    $.clock.every(10_000, () => sync($))
    return started
  })

  on('session.end', async ($, e, next) => {
    await ctl($, ['leave', sessionId, stopWithLastSession ? '1' : '0'])
    return next(e)
  })

  on('command.run', { command: 'radio' }, async ($, e) => {
    await sync($)
    const playing = (await read($, nowPlaying)) !== null
    const action = parse(e.args)
    switch (action.kind) {
      case 'toggle':
        if (playing) {
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
        return { text: listing(index, playing, volume) }
      case 'band': {
        const hidden = await update($, isBandHidden, was => !was)
        return { text: hidden ? 'Radio band hidden.' : 'Radio band shown while playing.' }
      }
      case 'volume': {
        volume = clamp(action.isRelative ? volume + action.value : action.value)
        const error = await applyVolume($)
        await redraw($)
        return { text: error ?? `Volume ${volume}` }
      }
      case 'unknown':
        return { text: `No station matches "${action.query}".\n\n${listing(index, playing, volume)}` }
    }
  })

  // A one-line player above the prompt while something plays.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, nowPlaying)
    if (e.props.hasSurvey || now === null || (await read($, isBandHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Button key="prev" label="◀" onPress={() => play($, index - 1)} />
        <Text> </Text>
        <Button key="stop" label="■" onPress={() => stop($)} />
        <Text> </Text>
        <Button key="next" label="▶" onPress={() => play($, index + 1)} />
        <Text> </Text>
        <Button key="down" label="−" onPress={() => adjust($, -10)} />
        <Button key="up" label="+" onPress={() => adjust($, 10)} />
        <Text dimColor wrap="truncate-end">
          {'  ♪ '}
          {now.name} · vol {volume}
        </Text>
      </Box>
    )
  })
}

async function adjust($: EngineInterface, step: number) {
  volume = clamp(volume + step)
  await applyVolume($)
  await redraw($)
}

/** The band shows the volume; nudge a redraw even when the station is unchanged. */
async function redraw($: EngineInterface) {
  await update($, nowPlaying, now => (now === null ? null : { ...now }))
}
