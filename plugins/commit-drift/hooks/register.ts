import type { EngineInterface, Register } from 'claude-code'

const REFRESH_MS = 60_000
// Nudge after an editing turn once the last commit is this old...
const NUDGE_AFTER_MIN = 30
// ...and no more often than this.
const NUDGE_EVERY_MS = 10 * 60_000

export type Drift = { project: string; dirty: number; lastCommitSec: number | null }

export function age(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${Math.floor(minutes / (24 * 60))}d`
}

export function minutesSince(drift: Drift, nowMs: number): number | null {
  if (drift.lastCommitSec === null) return null
  return Math.max(0, Math.floor((nowMs / 1000 - drift.lastCommitSec) / 60))
}

export function format(drift: Drift, nowMs: number): string {
  const minutes = minutesSince(drift, nowMs)
  const since = minutes === null ? 'no commits yet' : `${age(minutes)} since commit`
  if (drift.dirty === 0) return `${drift.project}: clean · ${since}`
  const files = drift.dirty === 1 ? '1 file' : `${drift.dirty} files`
  return `${drift.project}: ${files} uncommitted · ${since}`
}

async function git($: EngineInterface, root: string, args: string[]) {
  return $.process.run(['git', '-C', root, ...args]).catch(() => undefined)
}

// The repo followed: the one holding the file last edited, else the session's.
let root: string | undefined
let drift: Drift | undefined
let editsThisTurn = 0
let lastNudgeMs = -Infinity

async function check($: EngineInterface) {
  if (root === undefined) {
    drift = undefined
    $.ui.status(undefined)
    return
  }
  const status = await git($, root, ['status', '--porcelain'])
  if (status?.exitCode !== 0) return
  const log = await git($, root, ['log', '-1', '--format=%ct'])
  const lastCommitSec = log?.exitCode === 0 ? Number(log.stdout.trim()) || null : null
  drift = {
    project: root.split('/').pop() ?? root,
    dirty: status.stdout.split('\n').filter(line => line.trim() !== '').length,
    lastCommitSec,
  }
  $.ui.status(format(drift, await $.clock.now()))
}

async function follow($: EngineInterface, filePath: string) {
  const cut = filePath.lastIndexOf('/')
  const found = await git($, cut > 0 ? filePath.slice(0, cut) : '/', [
    'rev-parse',
    '--show-toplevel',
  ])
  if (found?.exitCode === 0) root = found.stdout.trim()
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    root = (await $.session.repo())?.root
    await check($)
    $.clock.every(REFRESH_MS, () => void check($))
    return started
  })

  on('prompt.submit', ($, e, next) => {
    editsThisTurn = 0
    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    editsThisTurn += 1
    await follow($, e.file_path)
    return ran
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    editsThisTurn += 1
    await follow($, e.file_path)
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (/\bgit\b/.test(e.command)) await check($)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    await check($)
    const now = await $.clock.now()
    const minutes = drift ? minutesSince(drift, now) : null
    const isStale = minutes === null || minutes >= NUDGE_AFTER_MIN
    if (drift && drift.dirty > 0 && editsThisTurn > 0 && isStale) {
      if (now - lastNudgeMs >= NUDGE_EVERY_MS) {
        lastNudgeMs = now
        $.ui.toast(`${format(drift, now)}: worth a commit?`, { timeoutMs: 8000 })
      }
    }
    return done
  })
}
