import type { EngineInterface, Register, SessionUsage } from 'claude-code'

// Toast once as the session's cost crosses each of these, in US dollars.
const THRESHOLDS = [5, 10, 25, 50, 100]
const REFRESH_MS = 15_000

export function format(usage: SessionUsage): string | undefined {
  const parts: string[] = []
  if (usage.cost !== undefined) parts.push(`$${usage.cost.usd.toFixed(2)}`)
  if (usage.context.percent !== undefined) parts.push(`ctx ${usage.context.percent}%`)
  const fiveHour = usage.rateLimits.find(limit => limit.kind === 'five_hour')
  if (fiveHour !== undefined) parts.push(`5h ${Math.round(fiveHour.percentUsed)}%`)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** How many thresholds `usd` has reached. */
export function crossed(usd: number): number {
  return THRESHOLDS.filter(limit => usd >= limit).length
}

// Thresholds already announced; seeded on load so a reload does not re-toast.
let announced = 0

async function refresh($: EngineInterface) {
  const usage = await $.session.usage()
  $.ui.status(format(usage))
  const usd = usage.cost?.usd ?? 0
  const reached = crossed(usd)
  if (reached > announced) {
    announced = reached
    $.ui.toast(`Session spend passed $${THRESHOLDS[reached - 1]} (now $${usd.toFixed(2)})`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    announced = crossed((await $.session.usage()).cost?.usd ?? 0)
    await refresh($)
    // usage() is free, so a timer keeps the line live through long turns.
    $.clock.every(REFRESH_MS, () => void refresh($))
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) await refresh($)
    return done
  })
}
