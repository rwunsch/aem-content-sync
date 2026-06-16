const { collides } = require('./scheduleCollision')
describe('schedule collision', () => {
  test('within window collides', () => { expect(collides('0 2 * * *', '0 3 * * *', 6 * 3600e3)).toBe(true) })
  test('outside window does not', () => { expect(collides('0 2 * * *', '0 12 * * *', 6 * 3600e3)).toBe(false) })
})
