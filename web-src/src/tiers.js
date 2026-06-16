const RANK = { prod: 3, production: 3, stage: 2, staging: 2, dev: 1, development: 1 }
function tierRank (type) { return RANK[String(type || '').toLowerCase()] || 0 }
// Valid copy destinations = environments strictly lower in tier than the source.
function allowedDestinations (environments, sourceEnvId) {
  const src = (environments || []).find((e) => String(e.id) === String(sourceEnvId))
  if (!src) return []
  const srcRank = tierRank(src.type)
  return (environments || []).filter((e) => String(e.id) !== String(sourceEnvId) && tierRank(e.type) < srcRank)
}
module.exports = { tierRank, allowedDestinations }
