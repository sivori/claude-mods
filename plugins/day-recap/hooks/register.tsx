import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Recap } from '../types'

const previous = atom({ plugin: 'day-recap', key: 'previous' } as const, null)
const isShown = atom({ plugin: 'day-recap', key: 'isShown' } as const, false)

// Once the session has been quiet this long, the model writes the recap.
const IDLE_MS = 10 * 60_000
const MAX_PROMPTS = 30
const MAX_FILES = 50

const ASK = `You are writing a note to the person for when they come back to this project.
Reply with exactly two lines and nothing else:
DONE: <one sentence on what got done this session, concrete, no fluff>
NEXT: <the single most useful next step, specific enough to start on cold>`

export function parseSummary(text: string): { done?: string; next?: string } {
  const line = (label: string) =>
    new RegExp(`^[\\s*]*${label}[\\s*]*:[\\s*]*(.+)$`, 'im').exec(text)?.[1]?.trim()
  return { done: line('DONE'), next: line('NEXT') }
}

/** What the recap says without the model: counts and the last thing asked. */
export function fallback(recap: Recap): { done: string; next: string } {
  const parts: string[] = []
  if (recap.commits.length > 0) {
    parts.push(`${recap.commits.length} commit${recap.commits.length === 1 ? '' : 's'}`)
  }
  if (recap.files.length > 0) {
    const shown = recap.files.slice(-3).map(file => file.split('/').pop())
    const more = recap.files.length - shown.length
    parts.push(`edited ${shown.join(', ')}${more > 0 ? ` (+${more})` : ''}`)
  }
  if (parts.length === 0) parts.push(`${recap.prompts.length} prompts, no edits`)
  const last = recap.prompts.at(-1)
  return { done: parts.join('; '), next: last ? `pick up from "${last}"` : 'start fresh' }
}

/** "today 5:12pm", "yesterday 9:03am", "Mon 4:40pm" or "Sep 28". */
export function when(thenMs: number, nowMs: number): string {
  const then = new Date(thenMs)
  const dayOf = (d: Date) => Math.floor((d.getTime() - d.getTimezoneOffset() * 60_000) / 86_400_000)
  const days = dayOf(new Date(nowMs)) - dayOf(then)
  const h = then.getHours()
  const time = `${h % 12 || 12}:${String(then.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`
  if (days <= 0) return `today ${time}`
  if (days === 1) return `yesterday ${time}`
  if (days < 7) return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][then.getDay()]} ${time}`
  const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')
  return `${months[then.getMonth()]} ${then.getDate()}`
}

export function describe(recap: Recap, nowMs: number): string {
  const { done, next } = recap.done ? { done: recap.done, next: recap.next ?? '' } : fallback(recap)
  return [`Last time in ${recap.project} (${when(recap.updatedAt, nowMs)})`, `Done: ${done}`, `Next: ${next}`].join('\n')
}

// This session's recap. A module variable: a reload re-reads it from the store.
let current: Recap | undefined
let idle: { cancel: () => void } | undefined

const keyOf = (root: string) => `recap:${root}`
const hasActivity = (recap: Recap) => recap.prompts.length > 0 || recap.files.length > 0

async function commitsSince($: EngineInterface, recap: Recap) {
  const ran = await $.process
    .run(['git', '-C', recap.root, 'log', `--since=@${Math.floor(recap.startedAt / 1000)}`, '--format=%s'])
    .catch(() => undefined)
  if (ran?.exitCode !== 0) return recap.commits
  return ran.stdout.split('\n').filter(line => line.trim() !== '').reverse()
}

async function save($: EngineInterface) {
  // A session that did nothing keeps the last real recap in place.
  if (current === undefined || !hasActivity(current)) return
  current = { ...current, commits: await commitsSince($, current), updatedAt: await $.clock.now() }
  await $.store.set(keyOf(current.root), current)
}

async function summarize($: EngineInterface): Promise<boolean> {
  if (current === undefined || !hasActivity(current)) return false
  const reply = await $.model.fork({ prompt: ASK })
  if (!reply.isAnswered) return false
  const { done, next } = parseSummary(reply.text)
  if (done === undefined) return false
  current = { ...current, done, next }
  await save($)
  return true
}

/** A recap from an earlier session that never got the model's summary gets one now. */
async function backfill($: EngineInterface, recap: Recap) {
  const ask = `${ASK}

Here is what the session recorded.
Prompts, oldest first:
${recap.prompts.map(p => `- ${p}`).join('\n') || '- (none)'}
Files edited: ${recap.files.join(', ') || '(none)'}
Commits: ${recap.commits.join('; ') || '(none)'}`
  const reply = await $.model.complete({ model: 'haiku', prompt: ask, maxTokens: 200, timeoutMs: 20_000 })
  if (!reply.isAnswered) return
  const { done, next } = parseSummary(reply.text)
  if (done === undefined) return
  const filled = { ...recap, done, next }
  await $.store.set(keyOf(recap.root), filled)
  await update($, previous, () => filled)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'recap',
      description: 'Write the recap of this session now; /recap last shows the one from last time',
      argumentHint: '[last]',
    })
    const started = await next(e)
    const root = (await $.session.repo())?.root ?? (await $.session.root())
    const sessionId = await $.session.id()
    const kept = (await $.store.get(keyOf(root))) as Recap | undefined

    if (kept?.sessionId === sessionId) {
      // A reload or a resume of the same session: carry on with it.
      current = kept
    } else {
      current = {
        sessionId,
        root,
        project: root.split('/').pop() ?? root,
        startedAt: await $.clock.now(),
        updatedAt: await $.clock.now(),
        prompts: [],
        files: [],
        commits: [],
      }
      if (kept !== undefined && hasActivity(kept)) {
        await update($, previous, () => kept)
        await update($, isShown, () => true)
        if (kept.done === undefined) $.clock.after(0, () => void backfill($, kept))
      }
    }
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    idle?.cancel()
    await update($, isShown, () => false)
    const first = e.text.trim().split('\n')[0]?.slice(0, 120) ?? ''
    if (current !== undefined && first !== '' && !first.startsWith('/')) {
      current = { ...current, prompts: [...current.prompts, first].slice(-MAX_PROMPTS) }
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (current === undefined || ran.isError || ran.deny !== undefined) return ran
    const path =
      e.tool === 'Edit' || e.tool === 'Write' ? e.file_path
      : e.tool === 'NotebookEdit' ? e.notebook_path
      : undefined
    if (path !== undefined) {
      const file = path.startsWith(`${current.root}/`) ? path.slice(current.root.length + 1) : path
      const files = [...current.files.filter(one => one !== file), file].slice(-MAX_FILES)
      current = { ...current, files }
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    await save($)
    idle?.cancel()
    idle = $.clock.after(IDLE_MS, () => void summarize($))
    return done
  })

  on('session.end', async ($, e, next) => {
    idle?.cancel()
    await save($)
    return next(e)
  })

  on('command.run', { command: 'recap' }, async ($, e) => {
    const now = await $.clock.now()
    if (e.args.trim() === 'last') {
      const recap = await read($, previous)
      if (recap === null) return { text: 'No recap from an earlier session here yet.' }
      await update($, isShown, () => true)
      return { text: describe(recap, now) }
    }
    if (current === undefined || !hasActivity(current)) {
      return { text: 'Nothing to recap yet this session.' }
    }
    if (!(await summarize($))) await save($)
    return { text: describe(current, now).replace(/^Last time in/, 'Recap for') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const recap = await read($, previous)
    if (e.props.hasSurvey || recap === null || !(await read($, isShown))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const { done, next: then } = recap.done ? { done: recap.done, next: recap.next ?? '' } : fallback(recap)

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Box>
          <Text dimColor wrap="truncate-end">
            ↩ Last time in {recap.project} · {when(recap.updatedAt, now)}{' '}
          </Text>
          <Button key="hide" label="Hide" onPress={() => update($, isShown, () => false)} />
        </Box>
        <Text wrap="truncate-end">
          {'  Done: '}
          {done}
        </Text>
        <Text wrap="truncate-end" bold>
          {'  Next: '}
          {then}
        </Text>
      </Box>
    )
  })
}
