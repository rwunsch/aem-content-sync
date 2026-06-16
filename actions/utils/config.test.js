const { migrate, jobPublishPaths } = require('./config')

describe('content set paths[]', () => {
  test('legacy single path migrates to paths[]', () => {
    const out = migrate({ jobs: [{ id: 'j', contentSets: [{ id: '1', path: '/content/a' }] }] })
    expect(out.jobs[0].contentSets[0].paths).toEqual(['/content/a'])
    expect(out.jobs[0].contentSets[0].path).toBeUndefined()
  })
  test('paths[] is preserved when already present', () => {
    const out = migrate({ jobs: [{ id: 'j', contentSets: [{ id: '1', paths: ['/content/a', '/content/b'] }] }] })
    expect(out.jobs[0].contentSets[0].paths).toEqual(['/content/a', '/content/b'])
  })
  test('jobPublishPaths flattens all paths of publish-enabled sets', () => {
    const job = { contentSets: [
      { id: '1', paths: ['/a', '/b'], publish: true },
      { id: '2', paths: ['/c'], publish: false }
    ] }
    expect(jobPublishPaths(job)).toEqual(['/a', '/b'])
  })
})

const pub = (p, legacy) => migrate({ jobs: [{ id: 'j', publish: p, onlyActivated: legacy }] }).jobs[0].publish
describe('publish modes', () => {
  test('prodMirror stays mirror', () => { expect(pub({ mode: 'prodMirror' }).mode).toBe('prodMirror') })
  test('treeActivation + onlyModified → onlyChanged', () => { expect(pub({ mode: 'treeActivation', onlyModified: true }).mode).toBe('onlyChanged') })
  test('treeActivation no filters → publishAll', () => { expect(pub({ mode: 'treeActivation', onlyActivated: false, onlyModified: false }).mode).toBe('publishAll') })
  test('treeActivation + onlyActivated → publishAll', () => { expect(pub({ mode: 'treeActivation', onlyActivated: true }).mode).toBe('publishAll') })
  test('bulkPublish preserved (advanced)', () => { expect(pub({ mode: 'bulkPublish' }).mode).toBe('bulkPublish') })
  test('unknown defaults to prodMirror', () => { expect(pub({}).mode).toBe('prodMirror') })
})
