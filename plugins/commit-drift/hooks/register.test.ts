import { expect, mock, test } from 'claude-code/testing'

import { age, format } from './register'

const NOW = 1_800_000_000_000

test('formats age and drift', () => {
  expect(age(5)).toBe('5m')
  expect(age(125)).toBe('2h 5m')
  expect(age(3 * 24 * 60)).toBe('3d')
  const lastCommitSec = NOW / 1000 - 23 * 60
  expect(format({ project: 'dash', dirty: 4, lastCommitSec }, NOW)).toBe(
    'dash: 4 files uncommitted · 23m since commit',
  )
  expect(format({ project: 'dash', dirty: 0, lastCommitSec: null }, NOW)).toBe(
    'dash: clean · no commits yet',
  )
})

test('status follows git, and an editing turn on a stale tree nudges', async ($, on) => {
  mock.clock(on, { now: NOW })
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  on('session.repo', () => ({ value: { root: '/work/dash', remote: null, internal: false, name: null } }))
  on('process.run', (_$, e) => {
    const args = e.argv.slice(3).join(' ')
    const stdout =
      args === 'status --porcelain' ? ' M a.ts\n?? b.ts\n'
      : args === 'log -1 --format=%ct' ? String(NOW / 1000 - 45 * 60)
      : '/work/dash\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', () => ({ cwd: '/work/dash' }))
  on('prompt.submit', (_$, e) => e as never)
  on('tool.call', () => ({ result: { text: 'ok' } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)

  await $.session.start({ cwd: '/work/dash' } as never)
  expect(statuses.at(-1)).toBe('dash: 2 files uncommitted · 45m since commit')

  const turn = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' }
  // A turn with no edits does not nudge.
  await $.turn.complete(turn as never)
  expect(toasts).toEqual([])

  await $.tool.call({ tool: 'Edit', tool_use_id: 'x', file_path: '/work/dash/a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete(turn as never)
  expect(toasts).toEqual(['dash: 2 files uncommitted · 45m since commit: worth a commit?'])

  // Rate-limited: a second editing turn right after stays quiet.
  await $.tool.call({ tool: 'Edit', tool_use_id: 'y', file_path: '/work/dash/a.ts', old_string: 'b', new_string: 'c' } as never)
  await $.turn.complete(turn as never)
  expect(toasts.length).toBe(1)
})
