import { expect, mock, test } from 'claude-code/testing'

import { crossed, format } from './register'

const usage = (usd: number) => ({
  startedAt: 0,
  context: { tokens: 84_000, window: 200_000, percent: 42 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 23.5 }],
  cost: { usd },
})

test('formats cost, context and the 5h window', () => {
  expect(format(usage(1.234))).toBe('$1.23 · ctx 42% · 5h 24%')
  expect(format({ startedAt: 0, context: { window: 1 }, rateLimits: [] })).toBeUndefined()
})

test('counts thresholds crossed', () => {
  expect(crossed(4.99)).toBe(0)
  expect(crossed(12)).toBe(2)
})

test('status line and threshold toast follow the ledger', async ($, on) => {
  mock.clock(on)
  let usd = 1
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  on('session.usage', () => ({ value: usage(usd) }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', () => ({ cwd: '/' }))
  on('turn.complete', () => ({ text: '' }) as never)

  await $.session.start({ cwd: '/work/dash' } as never)
  expect(statuses.at(-1)).toBe('$1.00 · ctx 42% · 5h 24%')
  expect(toasts).toEqual([])

  usd = 6.5
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  expect(statuses.at(-1)).toBe('$6.50 · ctx 42% · 5h 24%')
  expect(toasts).toEqual(['Session spend passed $5 (now $6.50)'])
})
