import { describe, expect, it } from 'vitest'
import { articleRoute, HOME_ROUTE } from './routes'

describe('application routes', () => {
  it('keeps the workspace at the root route', () => {
    expect(HOME_ROUTE).toBe('/')
  })

  it('encodes article identifiers into the App Router path', () => {
    expect(articleRoute('article/with space')).toBe('/articles/article%2Fwith%20space')
  })
})
