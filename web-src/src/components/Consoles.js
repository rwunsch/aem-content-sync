import React, { useEffect, useState } from 'react'
import { Flex, Link } from '@adobe/react-spectrum'
import { aemAuthorUrl, cloudManagerUrl } from './links'

/*
 * Consoles — a compact set of deep links to Cloud Manager and the connected
 * AEM author UIs. Rendered top-right in the header, under the "Connected" light,
 * so the operator can jump to the consoles from any tab without scrolling.
 *
 * The job records only carry env ids + a copy role (source = copy-FROM, the
 * higher tier; dest = copy-TO, the lower tier), so we label author links by
 * role rather than by tier type, and dedupe by URL across all jobs.
 */
export default function Consoles ({ api }) {
  const [imsOrgId, setImsOrgId] = useState(null)
  const [links, setLinks] = useState([])

  useEffect(() => {
    let alive = true
    api.integration().then((r) => { if (alive) setImsOrgId(r.integration && r.integration.imsOrgId) }).catch(() => {})
    api.status().then((s) => {
      if (!alive) return
      const jobs = (s && s.jobs) || []
      const seen = new Set()
      const out = []
      jobs.forEach((j) => {
        const src = aemAuthorUrl(j.programId, j.sourceEnvId)
        const dst = aemAuthorUrl(j.programId, j.destEnvId)
        if (src && !seen.has(src)) { seen.add(src); out.push({ url: src, label: `Author e${j.sourceEnvId} (source) ↗` }) }
        if (dst && !seen.has(dst)) { seen.add(dst); out.push({ url: dst, label: `Author e${j.destEnvId} (dest) ↗` }) }
      })
      setLinks(out)
    }).catch(() => {})
    return () => { alive = false }
  }, [api])

  return (
    <Flex direction="row" gap="size-150" alignItems="center" justifyContent="end" wrap UNSAFE_style={{ fontSize: '12px' }}>
      <Link UNSAFE_style={{ fontSize: '12px' }}><a href={cloudManagerUrl({ imsOrgId })} target="_blank" rel="noopener noreferrer">Cloud Manager ↗</a></Link>
      {links.map((l) => (
        <Link key={l.url} UNSAFE_style={{ fontSize: '12px' }}><a href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a></Link>
      ))}
    </Flex>
  )
}
