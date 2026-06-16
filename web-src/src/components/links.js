/*
 * Deep-link helpers back to the Adobe consoles for the configured
 * environments — so the operator can jump from this app straight to
 * Cloud Manager or the connected AEM author UIs.
 */

/** AEMaaCS author UI for a program/environment pair. */
export function aemAuthorUrl (programId, envId, path) {
  if (!programId || !envId) return null
  const base = `https://author-p${programId}-e${envId}.adobeaemcloud.com`
  return path ? base + path : base
}

/**
 * Cloud Manager (Adobe Experience Cloud shell). Best-effort program deep
 * link; falls back to the Cloud Manager home. organizationId forces the
 * right org context in the unified shell.
 */
export function cloudManagerUrl ({ programId, imsOrgId } = {}) {
  const org = imsOrgId ? `?organizationId=${encodeURIComponent(imsOrgId)}` : ''
  const hash = programId
    ? `#/cloud-manager/landing.html?programId=${encodeURIComponent(programId)}`
    : '#/cloud-manager'
  return `https://experience.adobe.com/${org}${hash}`
}
