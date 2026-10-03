import { describe, expect, mock, test } from 'claude-code/testing'

import type { Board, Quest } from '../types'
import { parseTodos, pick, testCommandOf } from './register'

const ROOT = '/work/dash'
const NOW = new Date(2026, 9, 3, 9, 30).getTime()
const PANE = { component: 'Pane', requestId: 'quest-board', props: {} } as const

const quest = (kind: Quest['kind'], n: number): Quest => ({
  id: `${kind}:${n}`,
  kind,
  title: `${kind} ${n}`,
  where: String(n),
  isDone: false,
})

describe('pure parts', () => {
  test('finds the test command inside a shell line', () => {
    expect(testCommandOf('cd web && npm test -- --run')).toBe('npm test -- --run')
    expect(testCommandOf('pytest -q tests/')).toBe('pytest -q tests/')
    expect(testCommandOf('npm run build')).toBeUndefined()
  })

  test('reads TODO lines from git grep', () => {
    const quests = parseTodos(
      'src/a.ts:12:  // TODO: handle the empty list\nREADME.md:3:a todo-free line\nsrc/b.py:4:# FIXME(ci) flaky retry */\nsrc/c.ts:9:// TODO\n',
    )
    expect(quests.map(q => [q.title, q.where])).toEqual([
      ['handle the empty list', 'src/a.ts:12'],
      ['ci) flaky retry', 'src/b.py:4'],
    ])
    expect(quests[0]?.needle).toBe('// TODO: handle the empty list')
  })

  test('draws one of each kind first, the same way for the same seed', () => {
    const pool = [quest('todo', 1), quest('todo', 2), quest('todo', 3), quest('issue', 1), quest('test', 1)]
    const drawn = pick(pool, 'day-1')
    expect(drawn.map(q => q.kind)).toEqual(['test', 'issue', 'todo'])
    expect(pick(pool, 'day-1')).toEqual(drawn)
    expect(pick([quest('todo', 1), quest('todo', 2)], 'x').length).toBe(2)
  })
})

test('draws a board, shows it, and celebrates each quest cleared', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>()
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  let todoGone = false
  let issueState = 'OPEN'

  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    const out = (exitCode: number, stdout = '') => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (argv.startsWith('git grep -n')) return out(0, 'src/a.ts:12:// TODO: handle the empty list\n')
    if (argv.startsWith('git grep -q')) return out(todoGone ? 1 : 0)
    if (argv.startsWith('gh issue list')) return out(0, JSON.stringify([{ number: 42, title: 'Pane flickers' }]))
    if (argv.startsWith('gh issue view')) return out(0, `${issueState}\n`)
    return out(1)
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: ROOT }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('tool.call', (_$, e) => {
    const command = (e as { command: string }).command
    return (command.includes('fail')
      ? { isError: true, result: 'Exit code 1', text: 'Exit code 1' }
      : { result: { stdout: 'ok', stderr: '', interrupted: false } }) as never
  })

  await $.session.start({ cwd: ROOT } as never)
  const drawn = store.get(`board:${ROOT}`) as Board
  expect(drawn.day).toBe('2026-10-03')
  expect(drawn.quests.map(q => q.kind)).toEqual(['issue', 'todo'])
  expect(statuses.at(-1)).toBe('⚔ quests 0/2')

  // A failing test run fills the third slot.
  await $.tool.call({ tool: 'Bash', tool_use_id: 'a', command: 'npm test --fail' } as never)
  expect(toasts.at(-1)).toBe('⚔ New quest: Get `npm test --fail` passing')

  const ui = await $.ui.mount({ plugin: 'quest-board', surface: 'terminal', ...PANE } as never)
  expect(await ui.find({ type: 'Text', text: /Pane flickers/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0\/3 done/ })).toBeDefined()
  await ui.unmount()

  todoGone = true
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  expect(toasts.at(-1)).toMatch(/^🏆 Quest complete: handle the empty list \(1\/3\)/)

  issueState = 'CLOSED'
  await $.command.run({ command: 'quests', args: 'check' } as never)
  expect(toasts.at(-1)).toMatch(/^🏆 Quest complete: Pane flickers \(2\/3\)/)

  // The failing command is remembered for tomorrow's draw.
  expect(store.get(`failing:${ROOT}`)).toEqual(['npm test --fail'])
})

test('a passing run of a failing test clears its quest and the board', async ($, on) => {
  mock.clock(on, { now: NOW })
  const board: Board = {
    day: '2026-10-03',
    root: ROOT,
    project: 'dash',
    quests: [
      { ...quest('todo', 1), isDone: true },
      { id: 'test:npm test', kind: 'test', title: 'Get `npm test` passing', where: 'npm test', isDone: false },
    ],
  }
  const store = new Map<string, unknown>([[`board:${ROOT}`, board], [`failing:${ROOT}`, ['npm test']]])
  const toasts: string[] = []
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: ROOT }))
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never)

  await $.session.start({ cwd: ROOT } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b', command: 'npm test' } as never)

  expect(toasts.at(-1)).toMatch(/^🎉 All 2 daily quests cleared!/)
  expect(store.get(`failing:${ROOT}`)).toEqual([])

  const ui = await $.ui.mount({ plugin: 'quest-board', surface: 'terminal', ...PANE } as never)
  expect(await ui.find({ type: 'Text', text: /Board cleared/ })).toBeDefined()
  await ui.unmount()
})
