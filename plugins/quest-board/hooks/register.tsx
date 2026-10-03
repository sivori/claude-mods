import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Quest, QuestKind } from '../types'

const board = atom({ plugin: 'quest-board', key: 'board' } as const, null)

const PANE = 'quest-board'
const QUESTS_PER_DAY = 3
// Issues are checked over the network: no more often than this.
const ISSUE_CHECK_MS = 10 * 60_000
const TODO = /\b(TODO|FIXME|HACK|XXX)\b[:(\s-]*(.*)$/
const TEST_COMMAND =
  /\b((npm|pnpm|yarn|bun)\s+(run\s+)?test|npx\s+(jest|vitest)|pytest|go\s+test|cargo\s+test|make\s+test|rspec|mix\s+test|vitest|jest|claude\s+plugin\s+test)\b/
const LABEL: Record<QuestKind, string> = { todo: 'TODO ', issue: 'ISSUE', test: 'TEST ' }
const CHEERS = ['Nice.', 'Clean hit.', 'Textbook.', 'Another one.', 'Momentum!']

/** The local day as `YYYY-MM-DD`. */
export function dayOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The test invocation inside a shell command (`cd x && npm test -- -u` → `npm test -- -u`). */
export function testCommandOf(command: string): string | undefined {
  const part = command.split(/&&|\|\||;|\|/).find(one => TEST_COMMAND.test(one))
  return part?.trim().replace(/\s+/g, ' ').slice(0, 80)
}

/** `git grep -n` lines (`file:line:text`) to TODO quests. */
export function parseTodos(stdout: string): Quest[] {
  const quests: Quest[] = []
  for (const line of stdout.split('\n')) {
    const at = /^([^:]+):(\d+):(.*)$/.exec(line)
    const found = at && TODO.exec(at[3] ?? '')
    if (!at || !found) continue
    const text = (found[2] ?? '').replace(/\s*(\*\/|-->|#\})\s*$/, '').trim()
    if (text.length < 4) continue
    const [, file = '', lineNo = ''] = at
    quests.push({
      id: `todo:${file}:${text}`,
      kind: 'todo',
      title: text.length > 70 ? `${text.slice(0, 69)}…` : text,
      where: `${file}:${lineNo}`,
      needle: (at[3] ?? '').trim(),
      isDone: false,
    })
  }
  return quests
}

function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * Up to `count` quests: one of each kind first (a failing test, then an issue,
 * then a TODO), the rest round-robin; the same seed draws the same quests.
 */
export function pick(pool: Quest[], seed: string, count = QUESTS_PER_DAY): Quest[] {
  const kinds: QuestKind[] = ['test', 'issue', 'todo']
  const groups = kinds.map(kind =>
    pool
      .filter(quest => quest.kind === kind)
      .sort((a, b) => hash(seed + a.id) - hash(seed + b.id)),
  )
  const picked: Quest[] = []
  while (picked.length < count && groups.some(group => group.length > 0)) {
    for (const group of groups) {
      const next = group.shift()
      if (next !== undefined && picked.length < count) picked.push(next)
    }
  }
  return picked
}

async function run($: EngineInterface, argv: string[], cwd: string) {
  return $.process.run(argv, { cwd, timeoutMs: 15_000 }).catch(() => undefined)
}

async function gather($: EngineInterface, root: string): Promise<Quest[]> {
  const todos = await run($, ['git', 'grep', '-n', '-I', '-E', '\\b(TODO|FIXME|HACK|XXX)\\b'], root)
  const issues = await run($, ['gh', 'issue', 'list', '--state', 'open', '--limit', '30', '--json', 'number,title'], root)
  const failing = ((await $.store.get(`failing:${root}`)) as string[] | undefined) ?? []

  const pool = todos?.exitCode === 0 ? parseTodos(todos.stdout).slice(0, 300) : []
  if (issues?.exitCode === 0) {
    try {
      for (const issue of JSON.parse(issues.stdout) as { number: number; title: string }[]) {
        pool.push({ id: `issue:${issue.number}`, kind: 'issue', title: issue.title, where: `#${issue.number}`, isDone: false })
      }
    } catch {
      // gh printed something other than JSON: no issue quests today.
    }
  }
  for (const command of failing) {
    pool.push({ id: `test:${command}`, kind: 'test', title: `Get \`${command}\` passing`, where: command, isDone: false })
  }
  return pool
}

// The repo the board follows. A module variable: a reload re-reads it from state.
let root: string | undefined
let lastIssueCheck = -Infinity

async function save($: EngineInterface, next: Board) {
  await update($, board, () => next)
  await $.store.set(`board:${next.root}`, next)
  const done = next.quests.filter(quest => quest.isDone).length
  $.ui.status(next.quests.length === 0 ? undefined : `⚔ quests ${done}/${next.quests.length}`)
}

async function celebrate($: EngineInterface, before: Board, after: Board) {
  const wasDone = new Set(before.quests.filter(quest => quest.isDone).map(quest => quest.id))
  const fresh = after.quests.filter(quest => quest.isDone && !wasDone.has(quest.id))
  if (fresh.length === 0) return
  const done = after.quests.filter(quest => quest.isDone).length
  const total = after.quests.length
  if (done === total) {
    $.ui.toast(`🎉 All ${total} daily quests cleared! The board refills tomorrow.`, { timeoutMs: 10_000 })
    return
  }
  const cheer = CHEERS[hash(fresh[0]?.id ?? '') % CHEERS.length]
  for (const quest of fresh) {
    $.ui.toast(`🏆 Quest complete: ${quest.title} (${done}/${total}). ${cheer}`, { timeoutMs: 7000 })
  }
}

/** Today's board for `at`: kept when drawn today, else a fresh draw. */
async function load($: EngineInterface, at: string) {
  const today = dayOf(await $.clock.now())
  const kept = (await $.store.get(`board:${at}`)) as Board | undefined
  if (kept?.day === today) {
    await save($, kept)
    return
  }
  const quests = pick(await gather($, at), `${today}:${at}`)
  await save($, { day: today, root: at, project: at.split('/').pop() ?? at, quests })
}

/** Marks TODOs that are gone and issues that are closed. */
async function check($: EngineInterface, force = false) {
  const current = await read($, board)
  if (current === null) return
  const now = await $.clock.now()
  const checkIssues = force || now - lastIssueCheck >= ISSUE_CHECK_MS
  if (checkIssues) lastIssueCheck = now

  const quests: Quest[] = []
  for (const quest of current.quests) {
    if (quest.isDone) {
      quests.push(quest)
    } else if (quest.kind === 'todo' && quest.needle !== undefined) {
      const file = quest.where.replace(/:\d+$/, '')
      const found = await run($, ['git', 'grep', '-q', '-F', '-e', quest.needle, '--', file], current.root)
      quests.push({ ...quest, isDone: found?.exitCode === 1 })
    } else if (quest.kind === 'issue' && checkIssues) {
      const seen = await run($, ['gh', 'issue', 'view', quest.where.slice(1), '--json', 'state', '-q', '.state'], current.root)
      quests.push({ ...quest, isDone: seen?.exitCode === 0 && seen.stdout.trim() === 'CLOSED' })
    } else {
      quests.push(quest)
    }
  }
  const next = { ...current, quests }
  await save($, next)
  await celebrate($, current, next)
}

/** Swaps the unfinished quests for new ones from today's pool. */
async function reroll($: EngineInterface): Promise<number> {
  const current = await read($, board)
  if (current === null) return 0
  const kept = current.quests.filter(quest => quest.isDone)
  const old = new Set(current.quests.map(quest => quest.id))
  const pool = (await gather($, current.root)).filter(quest => !old.has(quest.id))
  const seed = `${current.day}:${current.root}:${await $.clock.now()}`
  const drawn = pick(pool, seed, QUESTS_PER_DAY - kept.length)
  await save($, { ...current, quests: [...kept, ...drawn] })
  return drawn.length
}

/** A test command ran: a failure is remembered (and can become a quest), a pass can clear one. */
async function sawTest($: EngineInterface, command: string, passed: boolean) {
  if (root === undefined) return
  const key = `failing:${root}`
  const failing = ((await $.store.get(key)) as string[] | undefined) ?? []
  const rest = failing.filter(one => one !== command)
  await $.store.set(key, passed ? rest : [...rest, command].slice(-10))

  const current = await read($, board)
  if (current === null || current.root !== root) return
  const id = `test:${command}`
  const has = current.quests.some(quest => quest.id === id)
  if (passed && has) {
    const next = {
      ...current,
      quests: current.quests.map(quest => (quest.id === id ? { ...quest, isDone: true } : quest)),
    }
    await save($, next)
    await celebrate($, current, next)
  } else if (!passed && !has && current.quests.length < QUESTS_PER_DAY) {
    const quest: Quest = { id, kind: 'test', title: `Get \`${command}\` passing`, where: command, isDone: false }
    await save($, { ...current, quests: [...current.quests, quest] })
    $.ui.toast(`⚔ New quest: ${quest.title}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'quests',
      description: "Open today's quest board; /quests reroll swaps the unfinished ones",
      argumentHint: '[reroll | check]',
    })
    const started = await next(e)
    root = (await $.session.repo())?.root
    if (root === undefined) return started
    await load($, root)
    $.clock.after(0, () => void check($, true))
    const current = await read($, board)
    if (current?.quests.some(quest => !quest.isDone)) {
      void $.ui.open({ id: PANE, title: 'Daily quests' })
    }
    return started
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const command = testCommandOf(e.command)
    if (command === undefined || ran.deny !== undefined) return ran
    if (ran.isError) {
      await sawTest($, command, false)
    } else if (ran.result.backgroundTaskId === undefined && !ran.result.interrupted) {
      await sawTest($, command, true)
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || root === undefined) return done
    const current = await read($, board)
    // Past midnight: tomorrow's board.
    if (current !== null && current.day !== dayOf(await $.clock.now())) await load($, root)
    await check($)
    return done
  })

  on('command.run', { command: 'quests' }, async ($, e) => {
    if (root === undefined) return { text: 'Quests need a git repo; this session has none.' }
    const arg = e.args.trim()
    if (arg === 'reroll') {
      const drawn = await reroll($)
      return { text: drawn === 0 ? 'Nothing new to draw.' : `Drew ${drawn} new quest${drawn === 1 ? '' : 's'}.` }
    }
    if (arg === 'check') await check($, true)
    await $.ui.open({ id: PANE, title: 'Daily quests' })
    const current = await read($, board)
    const done = current?.quests.filter(quest => quest.isDone).length ?? 0
    return { text: `Quest board open: ${done}/${current?.quests.length ?? 0} done today.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, board)

    if (current === null || current.quests.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No quests today: no TODOs, open issues or failing tests found.</Text>
          <Text dimColor>Enjoy the clean slate.</Text>
        </Box>
      )
    }

    const done = current.quests.filter(quest => quest.isDone).length
    const isCleared = done === current.quests.length

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">
          {current.project} · {current.day}
        </Text>
        {current.quests.map(quest => (
          <Box key={quest.id} flexDirection="column" marginTop={1}>
            <Text wrap="truncate-end" dimColor={quest.isDone} strikethrough={quest.isDone}>
              {quest.isDone ? '☑ ' : '☐ '}
              <Text color={quest.kind === 'test' ? 'red' : quest.kind === 'issue' ? 'cyan' : 'yellow'}>
                {LABEL[quest.kind]}
              </Text>{' '}
              {quest.title}
            </Text>
            <Text dimColor wrap="truncate-start">
              {'    '}
              {quest.where}
            </Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text color={isCleared ? 'green' : undefined} bold={isCleared}>
            {isCleared ? '🎉 Board cleared! ' : `${done}/${current.quests.length} done `}
          </Text>
          {!isCleared && <Button key="reroll" label="Reroll" onPress={() => void reroll($)} />}
          <Button key="check" label="Check" onPress={() => void check($, true)} />
        </Box>
      </Box>
    )
  })
}
