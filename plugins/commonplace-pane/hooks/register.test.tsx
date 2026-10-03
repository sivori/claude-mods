import { expect, mock, test } from 'claude-code/testing'

import { agentHeader, fit, moodOf } from './register'

test('weather follows dirt and failures', () => {
  expect(moodOf(0, 0)).toBe('calm')
  expect(moodOf(5, 0)).toBe('overcast')
  expect(moodOf(0, 1)).toBe('overcast')
  expect(moodOf(12, 0)).toBe('storm')
  expect(moodOf(0, 3)).toBe('storm')
})

test('fits landscape to width and portrait to height', () => {
  expect(fit(900, 600, 60, 40)).toEqual({ columns: 60, rows: 20 })
  expect(fit(600, 900, 60, 20)).toEqual({ columns: 27, rows: 20 })
})

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

test('hangs a museum painting, and a dirty repo turns the weather', async ($, on) => {
  mock.clock(on)
  let dirty = ''
  const queries: string[] = []
  const toasts: string[] = []
  on('session.repo', () => ({ value: { root: '/work/dash', remote: null, internal: false, name: null } }))
  on('process.run', (_$, e) => {
    const [cmd, ...rest] = e.argv
    if (cmd === 'curl' && rest.includes('POST')) {
      const body = JSON.parse(String(rest[rest.indexOf('-d') + 1])) as { q: string }
      queries.push(body.q)
      const id = `img-${queries.length}`
      return ok(JSON.stringify({ data: [{ title: `Painting ${queries.length}`, artist_title: 'Turner', date_display: '1840', image_id: id }] }))
    }
    if (cmd === 'git') return ok(dirty)
    if (cmd === 'printenv') return ok('/Users/x\n')
    if (cmd === 'sips' && rest.includes('-g')) return ok('pixelWidth: 843\npixelHeight: 600\n')
    return ok('')
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.run', () => ({ text: '' }))
  on('session.start', () => ({ cwd: '/work/dash' }))
  on('turn.complete', () => ({ text: '' }) as never)

  await $.session.start({ cwd: '/work/dash' } as never)
  const first = await $.command.run({ command: 'commonplace', args: 'next' } as never)
  expect(first.text).toContain('Now hanging: Painting')
  expect(queries[0]).toContain('pastoral')

  const PANE = { component: 'Pane', requestId: 'commonplace', props: { title: 'Commonplace', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { top: 0, bodyRows: 30, rows: 0 }, view: {} }, viewport: { columns: 160, rows: 40 } } as const
  const ui = await $.ui.mount({ plugin: 'commonplace-pane', surface: 'terminal', ...PANE } as never)
  expect(await ui.find({ type: 'Image', key: 'art' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Turner, 1840 · ☀ calm/ })).toBeDefined()
  await ui.unmount()

  dirty = Array.from({ length: 12 }, (_, i) => ` M f${i}.ts`).join('\n')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  expect(toasts).toContain('⛈ The weather turns storm.')
  expect(queries.at(-1)).toContain('storm')
})

test('the museum header carries a contact only when one is configured', () => {
  expect(agentHeader('')).toBe('AIC-User-Agent: commonplace-pane')
  expect(agentHeader('me@example.com')).toBe('AIC-User-Agent: commonplace-pane (me@example.com)')
})
