// Minimal UTC cron field matcher (5 fields: min hour dom mon dow; supports
// '*', comma lists, a-b ranges, and */step or a-b/step).
function fieldMatch (field, value) {
  if (field === '*') return true
  return field.split(',').some((part) => {
    let step = 1, range = part
    if (part.includes('/')) { const [r, s] = part.split('/'); range = r; step = Number(s) }
    let lo, hi
    if (range === '*') { lo = -Infinity; hi = Infinity } else if (range.includes('-')) { const [a, b] = range.split('-').map(Number); lo = a; hi = b } else { lo = hi = Number(range) }
    if (value < lo || value > hi) return false
    if (step === 1) return true
    const base = (lo === -Infinity) ? 0 : lo
    return (value - base) % step === 0
  })
}
function due (cron, d) {
  const [mi, ho, dom, mo, dow] = cron.trim().split(/\s+/)
  return fieldMatch(mi, d.getUTCMinutes()) && fieldMatch(ho, d.getUTCHours()) &&
    fieldMatch(dom, d.getUTCDate()) && fieldMatch(mo, d.getUTCMonth() + 1) &&
    fieldMatch(dow, d.getUTCDay())
}
// Fire times over the next `days` at 5-minute resolution.
function fireTimes (cron, startMs, days = 7) {
  const out = []
  const step = 5 * 60e3
  for (let t = startMs; t < startMs + days * 86400e3; t += step) {
    if (due(cron, new Date(t))) out.push(t)
  }
  return out
}
// Two crons collide if any of their fire times fall within windowMs of each other.
function collides (cronA, cronB, windowMs, startMs = Date.UTC(2026, 0, 5)) {
  const a = fireTimes(cronA, startMs)
  const b = fireTimes(cronB, startMs)
  return a.some((ta) => b.some((tb) => Math.abs(ta - tb) < windowMs))
}
module.exports = { collides, fireTimes, due }
