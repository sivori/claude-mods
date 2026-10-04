import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { listing, parse, parseStatus, STATIONS } from './register'

test('bare /tune toggles; verbs map to actions', () => {
  expect(parse('')).toEqual({ kind: 'toggle' })
  expect(parse('stop')).toEqual({ kind: 'stop' })
  expect(parse('listen')).toEqual({ kind: 'resume' })
  expect(parse('play')).toEqual({ kind: 'resume' })
  expect(parse(' Next ')).toEqual({ kind: 'next' })
  expect(parse('ls')).toEqual({ kind: 'list' })
})

test('picks stations by number, name, then genre', () => {
  expect(parse('1')).toEqual({ kind: 'play', index: 0 })
  expect(parse(String(STATIONS.length + 1))).toEqual({ kind: 'unknown', query: String(STATIONS.length + 1) })
  expect(parse('groove')).toEqual({ kind: 'play', index: STATIONS.findIndex(s => s.name === 'SomaFM Groove Salad') })
  expect(parse('play wwfm')).toEqual({ kind: 'play', index: STATIONS.findIndex(s => s.name === 'WWFM Classical') })
  expect(parse('choral')).toEqual({ kind: 'play', index: STATIONS.findIndex(s => s.name === 'Classical Choral') })
  expect(parse('polka')).toEqual({ kind: 'unknown', query: 'polka' })
})

test('volume absolute and relative', () => {
  expect(parse('vol 30')).toEqual({ kind: 'volume', value: 30, isRelative: false })
  expect(parse('volume -10')).toEqual({ kind: 'volume', value: -10, isRelative: true })
  expect(parse('vol +5')).toEqual({ kind: 'volume', value: 5, isRelative: true })
})

test('listing marks the current station', () => {
  const text = listing(4, true, 40)
  expect(text).toContain('▶  5. SomaFM Groove Salad')
  expect(text).toContain('volume 40')
})

test('status output names the station and backend', () => {
  expect(parseStatus('4 mpv\n')).toEqual({ index: 4, name: 'SomaFM Groove Salad', backend: 'mpv' })
  expect(parseStatus('12 ffplay')).toEqual({ index: 12, name: 'WWFM Classical', backend: 'ffplay' })
  expect(parseStatus('')).toBeNull()
  expect(parse('band')).toEqual({ kind: 'band' })
})

type Shared = { now: string; backend: 'mpv' | 'ffplay'; volume?: string }

/** Stands in for the shared player: argv[4] is the CTL action. */
function fakePlayer(on: Parameters<TestBody>[1], shared: Shared, refuseCommand = false) {
  const runs: string[][] = []
  const statuses: (string | undefined)[] = []
  on('session.start', () => ({ cwd: '/' }))
  on('session.end', () => ({ sessionId: 's1' }) as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('command.register', (_$, e) => {
    if (refuseCommand) throw new Error(`"/${e.name}" refused: it is the built-in /${e.name}`)
    return { value: { command: e.name } } as never
  })
  on('clock.every', () => ({ value: { cancel() {} } }) as never)
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    const args = e.argv.slice(4)
    runs.push(args)
    const [action, a1] = args
    let exitCode = 0
    if (action === 'play') shared.now = a1 ?? ''
    if (action === 'stop') shared.now = ''
    if (action === 'vol') {
      if (shared.backend === 'mpv') shared.volume = a1
      else exitCode = 3
    }
    const stdout = action === 'status' && shared.now !== '' ? `${shared.now} ${shared.backend}` : ''
    return { value: { exitCode, stdout, stderr: '' } } as never
  })
  return { runs, statuses }
}

test('/tune registers and answers list', async ($, on) => {
  fakePlayer(on, { now: '', backend: 'mpv' })
  await $.session.start({ cwd: '/' } as never)
  const { text } = await $.command.run({ command: 'tune', args: 'list' } as never)
  expect(text).toContain('SomaFM Drone Zone')
})

test('play and stop drive the shared player and the status line', async ($, on) => {
  const shared: Shared = { now: '', backend: 'mpv' }
  const { runs, statuses } = fakePlayer(on, shared)
  await $.session.start({ cwd: '/' } as never)

  const played = await $.command.run({ command: 'tune', args: 'groove' } as never)
  expect(played.text).toBe('♪ SomaFM Groove Salad')
  expect(shared.now).toBe('4')
  expect(runs.find(r => r[0] === 'play')).toEqual(['play', '4', STATIONS[4]?.url ?? '', '50', '0'])
  expect(statuses.at(-1)).toBe('♪ SomaFM Groove Salad')

  const stopped = await $.command.run({ command: 'tune', args: 'stop' } as never)
  expect(stopped.text).toBe('Radio off.')
  expect(statuses.at(-1)).toBeUndefined()
})

test('picks up a stream another session started, and bare /tune stops it', async ($, on) => {
  const shared: Shared = { now: '12', backend: 'ffplay' } // WWFM, started elsewhere
  const { runs, statuses } = fakePlayer(on, shared)
  await $.session.start({ cwd: '/' } as never)
  expect(statuses.at(-1)).toBe('♪ WWFM Classical')
  expect(runs[0]).toEqual(['status', 's1'])

  const { text } = await $.command.run({ command: 'tune', args: '' } as never)
  expect(text).toBe('Radio off.')
  expect(runs.some(r => r[0] === 'play')).toBe(false)
  expect(shared.now).toBe('')
})

test('volume is live on mpv and a restart on ffplay', async ($, on) => {
  const shared: Shared = { now: '4', backend: 'mpv' }
  const { runs } = fakePlayer(on, shared)
  await $.session.start({ cwd: '/' } as never)

  await $.command.run({ command: 'tune', args: 'vol 30' } as never)
  expect(shared.volume).toBe('30')
  expect(runs.some(r => r[0] === 'play')).toBe(false)

  shared.backend = 'ffplay'
  await $.command.run({ command: 'tune', args: 'vol -10' } as never)
  expect(runs.find(r => r[0] === 'play')?.[3]).toBe('20')
})

test('stopWithLastSession arms the watchdog and the leave check', { options: { stopWithLastSession: true } }, async ($, on) => {
  const shared: Shared = { now: '', backend: 'mpv' }
  const { runs } = fakePlayer(on, shared)
  await $.session.start({ cwd: '/' } as never)
  await $.command.run({ command: 'tune', args: '1' } as never)
  expect(runs.find(r => r[0] === 'play')?.[4]).toBe('1')
  await $.session.end({ reason: 'exit' } as never)
  expect(runs.at(-1)).toEqual(['leave', 's1', '1'])
})

test('the band shows the station with working controls', async ($, on) => {
  const shared: Shared = { now: '4', backend: 'mpv' }
  fakePlayer(on, shared)
  await $.session.start({ cwd: '/' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    shared.now = '4'
    await $.command.run({ command: 'tune', args: 'list' } as never) // re-sync
    const ui = await $.ui.mount({
      plugin: 'radio',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { top: 0, bodyRows: 9, rows: 0 }, view: {} },
    } as never)
    expect(await ui.find({ type: 'Text', text: /SomaFM Groove Salad · vol 50/ })).toBeDefined()
    await ui.press({ key: 'next' } as never)
    expect(shared.now).toBe('5')
    await ui.unmount()
  }
})

test('a refused /tune registration still starts sync and the band', async ($, on) => {
  const shared: Shared = { now: '4', backend: 'mpv' }
  const { statuses } = fakePlayer(on, shared, true)
  await $.session.start({ cwd: '/' } as never)
  expect(statuses.at(-1)).toBe('♪ SomaFM Groove Salad')
})

test('stopped, the band keeps its controls and resumes the last station', async ($, on) => {
  const shared: Shared = { now: '4', backend: 'mpv' }
  fakePlayer(on, shared)
  await $.session.start({ cwd: '/' } as never)
  await $.command.run({ command: 'tune', args: 'stop' } as never)
  expect(shared.now).toBe('')
  const ui = await $.ui.mount({
    plugin: 'radio',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { top: 0, bodyRows: 9, rows: 0 }, view: {} },
  } as never)
  expect(await ui.find({ type: 'Text', text: /paused · SomaFM Groove Salad/ })).toBeDefined()
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  await ui.press({ key: 'play' } as never)
  expect(shared.now).toBe('4')
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  await ui.unmount()
})

test('a fresh session that has heard nothing shows no band', async ($, on) => {
  const shared: Shared = { now: '', backend: 'mpv' }
  fakePlayer(on, shared)
  await $.session.start({ cwd: '/' } as never)
  // The band passes the site on; with nothing beneath it in a test, mounting
  // says so, which is the proof that radio drew nothing.
  let passedOn = false
  try {
    await $.ui.mount({
      plugin: 'radio',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { top: 0, bodyRows: 9, rows: 0 }, view: {} },
    } as never)
  } catch (error) {
    passedOn = /no implementation for ui.render/.test(String(error))
  }
  expect(passedOn).toBe(true)
})
