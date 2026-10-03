import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Backlog } from '../types'

const backlog = atom({ plugin: 'backlog-band', key: 'backlog' } as const, null)
const isHidden = atom({ plugin: 'backlog-band', key: 'isHidden' } as const, false)

const MAX_ITEMS = 5
const OPEN_ITEM = /^-\s\[\s\]\s+(.*)$/
const HEADING = /^##\s+(\S+)/

/** The `## <name>` section's line range, or undefined when there is none. */
function sectionOf(lines: string[], name: string) {
  const start = lines.findIndex(line => HEADING.exec(line)?.[1]?.toLowerCase() === name)
  if (start < 0) return undefined
  const after = lines.slice(start + 1).findIndex(line => HEADING.test(line))
  return { start, end: after < 0 ? lines.length : start + 1 + after }
}

export function parseNow(text: string): string[] {
  const lines = text.split('\n')
  const now = sectionOf(lines, 'now')
  if (now === undefined) return []
  return lines
    .slice(now.start + 1, now.end)
    .map(line => OPEN_ITEM.exec(line)?.[1]?.trim())
    .filter((item): item is string => item !== undefined && item !== '')
}

/** Appends `- [ ] item` as the last entry of `## Next`, adding the section if missing. */
export function addToNext(text: string, item: string): string {
  const lines = text.split('\n')
  const next = sectionOf(lines, 'next')
  const entry = `- [ ] ${item}`
  if (next === undefined) {
    const someday = sectionOf(lines, 'someday')
    const at = someday?.start ?? lines.length
    lines.splice(at, 0, '## Next', entry, '')
    return lines.join('\n')
  }
  let at = next.end
  while (at > next.start + 1 && lines[at - 1]?.trim() === '') at -= 1
  lines.splice(at, 0, entry)
  return lines.join('\n')
}

async function gitRoot($: EngineInterface, dir: string) {
  const ran = await $.process
    .run(['git', '-C', dir, 'rev-parse', '--show-toplevel'])
    .catch(() => undefined)
  return ran?.exitCode === 0 ? ran.stdout.trim() : undefined
}

async function load($: EngineInterface, root: string) {
  const path = `${root}/BACKLOG.md`
  const exists = await $.fs.exists(path).catch(() => false)
  const found: Backlog | null = exists
    ? {
        path,
        project: root.split('/').pop() ?? root,
        now: parseNow(String(await $.fs.read(path))),
      }
    : null
  await update($, backlog, () => found)
}

// The project the band follows: the repo of the file last edited, else the session's.
// A module variable: a reload re-seeds it in session.start from the kept state.
let root: string | undefined

async function follow($: EngineInterface, filePath: string) {
  const cut = filePath.lastIndexOf('/')
  const found = await gitRoot($, cut > 0 ? filePath.slice(0, cut) : '/')
  if (found === undefined) return
  const isNew = found !== root
  root = found
  if (isNew || filePath.endsWith('/BACKLOG.md')) await load($, found)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'later',
      description: "Add an item to the active project's BACKLOG.md Next section",
      argumentHint: '<item>',
    })
    await $.command.register({
      name: 'backlog-band',
      description: 'Show or hide the backlog band above the prompt',
    })
    const kept = await read($, backlog)
    const fallback = (await $.session.repo())?.root ?? (await $.session.root())
    root = kept ? kept.path.replace(/\/BACKLOG\.md$/, '') : fallback
    await load($, root)
    return next(e)
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

  // Bash, /backlog or another session may have changed the file: re-read once per turn.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && root !== undefined) await load($, root)
    return done
  })

  on('command.run', { command: 'later' }, async ($, e) => {
    const item = e.args.trim()
    if (item === '') return { text: 'Usage: /later <item>' }
    const current = await read($, backlog)
    if (current === null) {
      return { text: `No BACKLOG.md at ${root ?? 'the session root'}; nothing added.` }
    }
    const text = String(await $.fs.read(current.path))
    await $.fs.write(current.path, addToNext(text, item))
    return { text: `Added to ${current.project} Next: ${item}` }
  })

  on('command.run', { command: 'backlog-band' }, async $ => {
    const hidden = await update($, isHidden, was => !was)
    return { text: hidden ? 'Backlog band hidden.' : 'Backlog band shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, backlog)
    if (e.props.hasSurvey || current === null || current.now.length === 0) return next(e)
    if (await read($, isHidden)) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const room = Math.max(1, Math.min(MAX_ITEMS, e.props.maxRows - 2))
    const shown = current.now.slice(0, room)
    const more = current.now.length - shown.length

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Text dimColor wrap="truncate-end">
          {current.project} · Now{more > 0 ? ` (+${more} more)` : ''}
        </Text>
        {shown.map(item => (
          <Text wrap="truncate-end">
            {'  ▸ '}
            {item}
          </Text>
        ))}
      </Box>
    )
  })
}
