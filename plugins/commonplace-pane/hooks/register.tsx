import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mood, Painting } from '../types'

const PANE = 'commonplace'
const ROTATE_MS = 20 * 60_000
const MOOD_CHECK_MS = 2 * 60_000
const AIC_SEARCH = 'https://api.artic.edu/api/v1/artworks/search'
const AIC_IIIF = 'https://www.artic.edu/iiif/2'
// The museum asks API clients to identify themselves; `contact` (an email or
// URL, optional) is appended when set.
export const agentHeader = (contact: string) =>
  `AIC-User-Agent: commonplace-pane${contact ? ` (${contact})` : ''}`
// Terminal cells are about twice as tall as they are wide.
const CELL_ASPECT = 2

const painting = atom({ plugin: 'commonplace-pane', key: 'painting' } as const, null)
const mood = atom({ plugin: 'commonplace-pane', key: 'mood' } as const, 'calm')

export const MOODS: Record<Mood, { query: string; glyph: string }> = {
  calm: { query: 'pastoral landscape summer meadow', glyph: '☀' },
  overcast: { query: 'clouds river landscape evening', glyph: '☁' },
  storm: { query: 'storm sea shipwreck', glyph: '⛈' },
}

const SEEDS: Record<Mood, { file: string; title: string; artist: string; date: string }[]> = {
  calm: [
    { file: 'seed-wheatfield', title: 'Wheat Field with Cypresses', artist: 'Vincent van Gogh', date: '1889' },
    { file: 'seed-harvesters', title: 'The Harvesters', artist: 'Pieter Bruegel the Elder', date: '1565' },
  ],
  overcast: [
    { file: 'seed-waterpitcher', title: 'Young Woman with a Water Pitcher', artist: 'Johannes Vermeer', date: 'ca. 1662' },
    { file: 'seed-rembrandt', title: 'Self-Portrait', artist: 'Rembrandt van Rijn', date: '1660' },
  ],
  storm: [
    { file: 'seed-wave', title: 'Under the Wave off Kanagawa', artist: 'Katsushika Hokusai', date: 'ca. 1830–32' },
  ],
}

/** The repo's weather: failing commands darken it fastest, then uncommitted sprawl. */
export function moodOf(dirty: number, recentFailures: number): Mood {
  if (recentFailures >= 3 || dirty >= 12) return 'storm'
  if (recentFailures >= 1 || dirty >= 4) return 'overcast'
  return 'calm'
}

/** The Image box for a picture, filling the width unless that overflows the rows. */
export function fit(width: number, height: number, columns: number, rows: number) {
  const tall = Math.round((columns * height) / width / CELL_ASPECT)
  if (tall <= rows) return { columns, rows: Math.max(1, tall) }
  return { columns: Math.max(1, Math.round((rows * CELL_ASPECT * width) / height)), rows }
}

function pick<T>(list: readonly T[]): T | undefined {
  return list[Math.floor(Math.random() * list.length)]
}

// Set from the plugin's options in register.
let AIC_AGENT = agentHeader('')
// Optional offline deck (a folder of seed-*.jpg): the floor when the museum is
// unreachable. Empty means no fallback.
let seedDir = ''

// Module state: which repo we watch, recent Bash outcomes, and a rotation guard.
let root: string | undefined
let bashFailures: boolean[] = []
const shown = new Set<string>()

async function home($: EngineInterface) {
  const found = await $.process.run(['printenv', 'HOME']).catch(() => undefined)
  return found?.exitCode === 0 && found.stdout.trim() !== '' ? found.stdout.trim() : '/tmp'
}

async function cacheDir($: EngineInterface) {
  return `${await home($)}/.cache/commonplace-pane`
}

async function run($: EngineInterface, argv: string[], timeoutMs = 30_000) {
  return $.process.run(argv, { timeoutMs }).catch(() => undefined)
}

async function toPng($: EngineInterface, from: string, to: string) {
  const converted = await run($, ['sips', '-s', 'format', 'png', from, '--out', to])
  if (converted?.exitCode !== 0) return undefined
  const dims = await run($, ['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', to])
  const width = Number(/pixelWidth: (\d+)/.exec(dims?.stdout ?? '')?.[1])
  const height = Number(/pixelHeight: (\d+)/.exec(dims?.stdout ?? '')?.[1])
  return width > 0 && height > 0 ? { width, height } : undefined
}

async function fromMuseum($: EngineInterface, want: Mood): Promise<Painting | undefined> {
  const body = JSON.stringify({
    q: MOODS[want].query,
    query: {
      bool: {
        must: [
          { term: { is_public_domain: true } },
          { exists: { field: 'image_id' } },
          { exists: { field: 'artist_title' } },
          { match: { artwork_type_title: 'Painting' } },
        ],
      },
    },
    fields: ['id', 'title', 'artist_title', 'date_display', 'image_id'],
    limit: 40,
  })
  const found = await run($, [
    'curl', '-sS', '--max-time', '15', '-X', 'POST', AIC_SEARCH,
    '-H', 'Content-Type: application/json', '-H', AIC_AGENT, '-d', body,
  ])
  if (found?.exitCode !== 0) return undefined
  type Hit = { title: string; artist_title: string; date_display: string; image_id: string }
  const hits = ((JSON.parse(found.stdout) as { data?: Hit[] }).data ?? []).filter(
    hit => hit.image_id && !shown.has(hit.image_id),
  )
  const hit = pick(hits)
  if (hit === undefined) return undefined

  const dir = await cacheDir($)
  const jpg = `${dir}/${hit.image_id}.jpg`
  const png = `${dir}/${hit.image_id}.png`
  await run($, ['mkdir', '-p', dir])
  const got = await run($, [
    'curl', '-sS', '--max-time', '30', '-o', jpg, '-H', AIC_AGENT,
    `${AIC_IIIF}/${hit.image_id}/full/843,/0/default.jpg`,
  ])
  if (got?.exitCode !== 0) return undefined
  const size = await toPng($, jpg, png)
  if (size === undefined) return undefined
  shown.add(hit.image_id)
  return {
    file: png,
    title: hit.title,
    artist: hit.artist_title,
    date: hit.date_display,
    ...size,
    mood: want,
  }
}

async function fromSeed($: EngineInterface, want: Mood): Promise<Painting | undefined> {
  const seed = pick(SEEDS[want])
  if (seed === undefined || seedDir === '') return undefined
  const dir = await cacheDir($)
  await run($, ['mkdir', '-p', dir])
  const png = `${dir}/${seed.file}.png`
  const size = await toPng($, `${seedDir.replace(/^~(?=\/)/, await home($))}/${seed.file}.jpg`, png)
  if (size === undefined) return undefined
  return { file: png, title: seed.title, artist: seed.artist, date: seed.date, ...size, mood: want }
}

// One hanging at a time; a caller arriving mid-hang waits for that one.
let hanging: Promise<void> | undefined

async function hangOnce($: EngineInterface) {
  const want = await read($, mood)
  const next = (await fromMuseum($, want)) ?? (await fromSeed($, want))
  if (next !== undefined) await update($, painting, () => next)
}

async function hang($: EngineInterface) {
  hanging ??= hangOnce($).finally(() => {
    hanging = undefined
  })
  return hanging
}

async function checkWeather($: EngineInterface) {
  let dirty = 0
  if (root !== undefined) {
    const status = await run($, ['git', '-C', root, 'status', '--porcelain'])
    if (status?.exitCode === 0) dirty = status.stdout.split('\n').filter(l => l.trim()).length
  }
  const now = moodOf(dirty, bashFailures.filter(Boolean).length)
  const was = await read($, mood)
  if (now === was) return
  await update($, mood, () => now)
  $.ui.toast(`${MOODS[now].glyph} The weather turns ${now}.`)
  await hang($)
}

async function follow($: EngineInterface, filePath: string) {
  const cut = filePath.lastIndexOf('/')
  const found = await run($, ['git', '-C', cut > 0 ? filePath.slice(0, cut) : '/', 'rev-parse', '--show-toplevel'])
  if (found?.exitCode === 0) root = found.stdout.trim()
}

export const register: Register = (on, options) => {
  AIC_AGENT = agentHeader(String(options.contact ?? '').trim())
  seedDir = String(options.seedDir ?? '').trim().replace(/\/$/, '')

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'commonplace',
      description: 'Open the painting pane; `/commonplace next` hangs a new one',
      argumentHint: '[next]',
    })
    root = (await $.session.repo())?.root
    void $.ui.open({ id: PANE, title: 'Commonplace' })
    if ((await read($, painting)) === null) void hang($)
    $.clock.every(ROTATE_MS, () => void hang($))
    $.clock.every(MOOD_CHECK_MS, () => void checkWeather($))
    return started
  })

  on('command.run', { command: 'commonplace' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Commonplace' })
    if (e.args.trim() === 'next') {
      await hang($)
      const now = await read($, painting)
      return { text: now ? `Now hanging: ${now.title}, ${now.artist}` : 'The museum is closed; no new painting.' }
    }
    return { text: 'Commonplace pane opened.' }
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    await follow($, e.file_path)
    return ran
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    await follow($, e.file_path)
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    bashFailures = [...bashFailures, ran.deny === undefined && ran.isError === true].slice(-10)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) await checkWeather($)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const now = await read($, painting)
    const weather = await read($, mood)
    if (now === null) {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>Hanging a painting…</Text>
    }
    const caption = `${now.artist}, ${now.date} · ${MOODS[weather].glyph} ${weather}`
    if (e.surface === 'terminal') {
      const { Box, Image, Text } = $.ui.resolve(e)
      const box = fit(now.width, now.height, e.props.bodyColumns, Math.max(4, (e.viewport?.rows ?? 30) - 6))
      return (
        <Box flexDirection="column">
          <Image
            key="art"
            source={{ file: now.file, format: 'png' }}
            columns={box.columns}
            rows={box.rows}
            alt={`${now.title}, ${now.artist}`}
          />
          <Text bold wrap="truncate-end">{now.title}</Text>
          <Text dimColor wrap="truncate-end">{caption}</Text>
        </Box>
      )
    }
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text bold>{now.title}</Text>
        <Text dimColor>{caption}</Text>
      </Box>
    )
  })
}
