'use strict'

// Node 18 has fetch built-in — no node-fetch needed

async function sendSlack (webhookUrl, payload) {
  if (!webhookUrl) {
    console.log('[notify] No webhook URL configured, skipping Slack notification')
    return
  }
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (!res.ok) console.error(`[notify] Slack webhook failed: HTTP ${res.status}`)
}

function buildSuccessMessage (config, job, runId, startedAt, log) {
  const durationMs = Date.now() - new Date(startedAt).getTime()
  const durationMin = Math.round(durationMs / 60000)
  const sets = (job.contentSets || []).map(s => `• ${s.path || s.label || s.id}`).join('\n') || '—'
  const paths = (job.publishPaths || []).map(p => `• ${p}`).join('\n') || '—'
  return {
    text: `:white_check_mark: *AEM Content Sync completed* — Stage is ready for QA`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:white_check_mark: *AEM Content Sync — ${job.name || 'sync'}* (Prod → Stage)\nRun \`${runId}\` completed in *${durationMin} min*`
        }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Content sets copied:*\n${sets}` },
          { type: 'mrkdwn', text: `*Paths published:*\n${paths}` }
        ]
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Program p${job.programId} | Source env ${job.sourceEnvId} → Dest env ${job.destEnvId}` }]
      }
    ]
  }
}

function buildFailureMessage (config, job, runId, reason, log) {
  const lastLogs = log.slice(-5).join('\n')
  return {
    text: `:x: *AEM Content Sync FAILED* — manual intervention needed`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:x: *AEM Content Sync FAILED* — ${job ? job.name : 'sync'}\nRun \`${runId}\`\n*Reason:* ${reason}`
        }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Last log entries:*\n\`\`\`${lastLogs}\`\`\`` }
      }
    ]
  }
}

module.exports = { sendSlack, buildSuccessMessage, buildFailureMessage }
