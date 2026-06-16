const { tierRank, allowedDestinations } = require('./tiers')
describe('downstream-only', () => {
  const envs = [{ id: '1', type: 'prod' }, { id: '2', type: 'stage' }, { id: '3', type: 'dev' }]
  test('rank order prod>stage>dev', () => {
    expect(tierRank('prod')).toBeGreaterThan(tierRank('stage'))
    expect(tierRank('stage')).toBeGreaterThan(tierRank('dev'))
  })
  test('prod source → stage+dev', () => { expect(allowedDestinations(envs, '1').map(e => e.id).sort()).toEqual(['2', '3']) })
  test('stage source → dev only', () => { expect(allowedDestinations(envs, '2').map(e => e.id)).toEqual(['3']) })
  test('dev source → none', () => { expect(allowedDestinations(envs, '3')).toEqual([]) })
})
