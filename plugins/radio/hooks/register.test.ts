import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { listing, parse, STATIONS } from './register'

test('bare /radio toggles; verbs map to actions', () => {
  expect(parse('')).toEqual({ kind: 'toggle' })
  expect(parse('stop')).toEqual({ kind: 'stop' })
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

/** Stands in for the shared player: argv[4] is the CTL action. */
function fakePlayer(on: Parameters<TestBody>[1], shared: { now: string }) {
  const actions: string[] = []
  const statuses: (string | undefined)[] = []
  on('session.start', () => ({ cwd: '/' }))
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  on('clock.every', () => ({ value: { cancel() {} } }) as never)
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    const [action, idx] = e.argv.slice(4)
    actions.push(action ?? '')
    if (action === 'play') shared.now = idx ?? ''
    if (action === 'stop') shared.now = ''
    return { value: { exitCode: 0, stdout: action === 'status' ? shared.now : '', stderr: '' } } as never
  })
  return { actions, statuses }
}

test('/radio registers and answers list', async ($, on) => {
  fakePlayer(on, { now: '' })
  await $.session.start({ cwd: '/' } as never)
  const { text } = await $.command.run({ command: 'radio', args: 'list' } as never)
  expect(text).toContain('SomaFM Drone Zone')
})

test('play and stop drive the shared player and the status line', async ($, on) => {
  const shared = { now: '' }
  const { actions, statuses } = fakePlayer(on, shared)
  await $.session.start({ cwd: '/' } as never)

  const played = await $.command.run({ command: 'radio', args: 'groove' } as never)
  expect(played.text).toBe('♪ SomaFM Groove Salad')
  expect(shared.now).toBe(String(STATIONS.findIndex(s => s.name === 'SomaFM Groove Salad')))
  expect(statuses.at(-1)).toBe('♪ SomaFM Groove Salad')

  const stopped = await $.command.run({ command: 'radio', args: 'stop' } as never)
  expect(stopped.text).toBe('Radio off.')
  expect(actions).toContain('stop')
  expect(statuses.at(-1)).toBeUndefined()
})

test('picks up a stream another session started, and bare /radio stops it', async ($, on) => {
  const shared = { now: '12' } // WWFM, started elsewhere
  const { actions, statuses } = fakePlayer(on, shared)
  await $.session.start({ cwd: '/' } as never)
  expect(statuses.at(-1)).toBe('♪ WWFM Classical')

  const { text } = await $.command.run({ command: 'radio', args: '' } as never)
  expect(text).toBe('Radio off.')
  expect(actions).not.toContain('play')
  expect(shared.now).toBe('')
})
