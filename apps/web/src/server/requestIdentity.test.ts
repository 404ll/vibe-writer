import { describe, expect, it } from 'vitest'
import {
  parseRequestIdentity,
  PRINCIPAL_HEADER,
  WORKSPACE_HEADER,
} from './requestIdentity'

describe('durable request identity boundary', () => {
  it('fails closed until the trusted proxy mode is explicit', () => {
    expect(parseRequestIdentity(new Headers(), undefined)).toEqual({
      status: 'auth_unconfigured',
    })
  })

  it('requires canonical internal principal and workspace ids', () => {
    const headers = new Headers({
      [PRINCIPAL_HEADER]: '11111111-1111-4111-8111-111111111111',
      [WORKSPACE_HEADER]: '22222222-2222-4222-8222-222222222222',
    })
    expect(parseRequestIdentity(headers, 'trusted-proxy')).toEqual({
      status: 'parsed',
      scope: {
        principalId: '11111111-1111-4111-8111-111111111111',
        workspaceId: '22222222-2222-4222-8222-222222222222',
      },
    })
    headers.set(PRINCIPAL_HEADER, 'external-user-name')
    expect(parseRequestIdentity(headers, 'trusted-proxy')).toEqual({
      status: 'unauthenticated',
    })
  })

  it('supports an explicit header-free identity only in development', () => {
    const environment = {
      NODE_ENV: 'development',
      DURABLE_AUTH_MODE: 'local-development',
      DURABLE_LOCAL_PRINCIPAL_ID: '11111111-1111-4111-8111-111111111111',
      DURABLE_LOCAL_WORKSPACE_ID: '22222222-2222-4222-8222-222222222222',
    } as const
    expect(parseRequestIdentity(
      new Headers({
        [PRINCIPAL_HEADER]: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        [WORKSPACE_HEADER]: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
      'local-development',
      environment,
    )).toEqual({
      status: 'parsed',
      scope: {
        principalId: environment.DURABLE_LOCAL_PRINCIPAL_ID,
        workspaceId: environment.DURABLE_LOCAL_WORKSPACE_ID,
      },
    })
    expect(parseRequestIdentity(new Headers(), 'local-development', {
      ...environment,
      NODE_ENV: 'production',
    })).toEqual({ status: 'auth_unconfigured' })
    expect(parseRequestIdentity(new Headers(), 'local-development', {
      ...environment,
      DURABLE_LOCAL_PRINCIPAL_ID: 'not-a-uuid',
    })).toEqual({ status: 'auth_unconfigured' })
  })
})
