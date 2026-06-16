'use strict'

/*
 * Minimal 5-field cron evaluator: "min hour day-of-month month day-of-week".
 * Supports *, lists (a,b), ranges (a-b), and steps (* / n  or  a-b/n).
 * No dependency — bundles cleanly and is enough for sync schedules.
 *
 * All evaluation is in UTC (I/O Runtime alarms fire in UTC).
 */

function parseField (field, min, max) {
  // returns a Set of allowed integer values
  const allowed = new Set()
  for (const part of String(field).split(',')) {
    let [range, stepStr] = part.split('/')
    const step = stepStr ? parseInt(stepStr, 10) : 1
    let lo, hi
    if (range === '*') {
      lo = min; hi = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      lo = parseInt(a, 10); hi = parseInt(b, 10)
    } else {
      lo = hi = parseInt(range, 10)
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) continue
    for (let v = lo; v <= hi; v += step) allowed.add(v)
  }
  return allowed
}

/**
 * Does the cron expression match the given Date (UTC, minute granularity)?
 */
function cronMatches (expr, date) {
  const parts = String(expr).trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [minF, hourF, domF, monF, dowF] = parts

  const min = parseField(minF, 0, 59)
  const hour = parseField(hourF, 0, 23)
  const dom = parseField(domF, 1, 31)
  const mon = parseField(monF, 1, 12)
  const dow = parseField(dowF, 0, 6) // 0 = Sunday

  if (!min.has(date.getUTCMinutes())) return false
  if (!hour.has(date.getUTCHours())) return false
  if (!mon.has(date.getUTCMonth() + 1)) return false

  // Standard cron DOM/DOW semantics: if both restricted, match either; else match both.
  const domRestricted = domF !== '*'
  const dowRestricted = dowF !== '*'
  const domOk = dom.has(date.getUTCDate())
  const dowOk = dow.has(date.getUTCDay())
  if (domRestricted && dowRestricted) {
    if (!(domOk || dowOk)) return false
  } else {
    if (!domOk || !dowOk) return false
  }
  return true
}

/**
 * Is the cron due to have fired in the window (fromMs, toMs]? Scans minute by
 * minute so a missed scheduler tick doesn't drop a scheduled run. The scan is
 * capped to the last 25h to bound work if `fromMs` is very old (or 0).
 */
function isDue (expr, fromMs, toMs) {
  const MAX_LOOKBACK_MS = 25 * 60 * 60 * 1000
  let start = fromMs && fromMs > 0 ? fromMs : toMs - 60 * 1000
  if (toMs - start > MAX_LOOKBACK_MS) start = toMs - MAX_LOOKBACK_MS

  // Align to the next whole minute strictly after `start`.
  const first = new Date(start)
  first.setUTCSeconds(0, 0)
  let t = first.getTime() + 60 * 1000
  for (; t <= toMs; t += 60 * 1000) {
    if (cronMatches(expr, new Date(t))) return true
  }
  return false
}

/** Human-readable-ish summary of common cron patterns (best effort). */
function describeCron (expr) {
  const parts = String(expr).trim().split(/\s+/)
  if (parts.length !== 5) return expr
  const [m, h, dom, mon, dow] = parts
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const time = (/^\d+$/.test(h) && /^\d+$/.test(m))
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} UTC`
    : null
  if (dom === '*' && mon === '*' && dow !== '*' && time) {
    const days = dow.split(',').map((d) => DAYS[parseInt(d, 10)] || d).join(', ')
    return `${days} at ${time}`
  }
  if (dom === '*' && mon === '*' && dow === '*' && time) return `Daily at ${time}`
  return expr
}

module.exports = { cronMatches, isDue, describeCron, parseField }
