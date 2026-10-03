import { describe, expect, test } from 'claude-code/testing'

import { addToNext, parseNow } from './register'

const BACKLOG = `# demo

## Now
- [ ] Ship the band @blocked
- [x] 2026-09-01 already done
- [ ] Second thing

## Next
- [ ] Queued one

## Someday
- [ ] Maybe @idea

## Done
`

const ROOT = '/work/demo'
const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { top: 0, bodyRows: 9, rows: 0 },
    view: {},
  },
} as const

describe('parsing', () => {
  test('reads only open Now items', () => {
    expect(parseNow(BACKLOG)).toEqual(['Ship the band @blocked', 'Second thing'])
  })

  test('/later appends at the end of Next', () => {
    const lines = addToNext(BACKLOG, 'New idea').split('\n')
    expect(lines.indexOf('- [ ] New idea')).toBe(lines.indexOf('- [ ] Queued one') + 1)
  })

  test('/later adds a Next section before Someday when missing', () => {
    const text = '## Now\n- [ ] a\n\n## Someday\n- [ ] b\n'
    const lines = addToNext(text, 'c').split('\n')
    expect(lines.indexOf('## Next')).toBeLessThan(lines.indexOf('## Someday'))
    expect(lines.indexOf('- [ ] c')).toBe(lines.indexOf('## Next') + 1)
  })
})

test('the band shows the session repo’s Now items, and /later writes Next', async ($, on) => {
  let written = ''
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }))
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: written === '' ? BACKLOG : written }))
  on('fs.write', (_$, e) => {
    written = e.text
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: ROOT }))

  await $.session.start({ cwd: ROOT } as never)

  const ui = await $.ui.mount({ plugin: 'backlog-band', surface: 'terminal', ...BAND } as never)
  expect(await ui.find({ type: 'Text', text: /demo · Now/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Ship the band/ })).toBeDefined()
  await ui.unmount()

  const ran = await $.command.run({ command: 'later', args: 'Write tests' } as never)
  expect(ran.text).toContain('Added to demo Next')
  expect(written).toContain('- [ ] Queued one\n- [ ] Write tests')
})
