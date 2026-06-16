'use strict'

const { matches } = require('./authz')
const { normaliseAccessProfiles, DEFAULT_ACCESS_PROFILES } = require('./config')

describe('authz.matches', () => {
  const DEP = 'CM_CS_DEPLOYMENT_MANAGER_ROLE_PROFILE'
  const PROG = 'CM_CS_PROGRAM_MANAGER_ROLE_PROFILE'
  const DEV = 'CM_CS_DEVELOPER_ROLE_PROFILE'

  test('exact match grants access', () => {
    expect(matches([DEV, DEP], [DEP, PROG])).toBe(true)
  })

  test('no overlap is denied', () => {
    expect(matches([DEV], [DEP, PROG])).toBe(false)
  })

  test('prefix match (AEM Administrators - author - Program …)', () => {
    expect(matches(['AEM Administrators - author - Program 12345 - Environment 67890'], ['AEM Administrators'])).toBe(true)
  })

  test("'*' allows any caller, even with no groups", () => {
    expect(matches([], ['*'])).toBe(true)
    expect(matches(['whatever'], ['*'])).toBe(true)
  })

  test('empty / invalid allowed list denies', () => {
    expect(matches([DEP], [])).toBe(false)
    expect(matches([DEP], null)).toBe(false)
    expect(matches([DEP], undefined)).toBe(false)
  })

  test('empty caller groups with concrete required list denies', () => {
    expect(matches([], [DEP])).toBe(false)
  })
})

describe('config.normaliseAccessProfiles', () => {
  test('unset / non-array → default (Deployment + Program Manager)', () => {
    expect(normaliseAccessProfiles(undefined)).toEqual(DEFAULT_ACCESS_PROFILES)
    expect(normaliseAccessProfiles(null)).toEqual(DEFAULT_ACCESS_PROFILES)
    expect(normaliseAccessProfiles('nope')).toEqual(DEFAULT_ACCESS_PROFILES)
  })

  test('empty array → default (cannot accidentally lock everyone out)', () => {
    expect(normaliseAccessProfiles([])).toEqual(DEFAULT_ACCESS_PROFILES)
    expect(normaliseAccessProfiles(['', '  '])).toEqual(DEFAULT_ACCESS_PROFILES)
  })

  test("'*' anywhere collapses to ['*'] (open to any org user)", () => {
    expect(normaliseAccessProfiles(['CM_CS_DEVELOPER_ROLE_PROFILE', '*'])).toEqual(['*'])
  })

  test('trims and keeps concrete profiles', () => {
    expect(normaliseAccessProfiles([' CM_CS_DEPLOYMENT_MANAGER_ROLE_PROFILE '])).toEqual(['CM_CS_DEPLOYMENT_MANAGER_ROLE_PROFILE'])
  })
})
