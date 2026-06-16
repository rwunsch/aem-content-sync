// Small shared helpers used across the Spectrum components.

export function statusVariant (s) {
  switch (s) {
    case 'SUCCEEDED': return 'positive'
    case 'FAILED': return 'negative'
    case 'CANCELLED': return 'notice'
    case 'RUNNING': return 'info'
    default: return 'neutral'
  }
}

// Best-effort human-readable cron (UTC). Mirrors the backend describeCron.
export function describeCron (expr) {
  const parts = String(expr || '').trim().split(/\s+/)
  if (parts.length !== 5) return expr || ''
  const [m, h, dom, mon, dow] = parts
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const num = (x) => /^\d+$/.test(x)
  const time = num(h) && num(m) ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} UTC` : null
  if (dom === '*' && mon === '*' && dow !== '*' && time) {
    const days = dow.split(',').map((d) => DAYS[parseInt(d, 10)] || d).join(', ')
    return `${days} at ${time}`
  }
  if (dom === '*' && mon === '*' && dow === '*' && time) return `Daily at ${time}`
  return expr
}
