import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pageData = vi.hoisted(() => ({ load: vi.fn() }))

vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }))
vi.mock('@/server/memory/memoryManagementPageData', () => ({
  loadMemoryManagementPageData: pageData.load,
}))
vi.mock('@/components/memory/MemoryManagementWorkspace', () => ({
  MemoryManagementWorkspace: () => <h1>长期记忆管理</h1>,
}))

import MemoryPage from './page'

describe('Memory management page', () => {
  beforeEach(() => pageData.load.mockReset())

  it('renders the role-aware workspace after server bootstrap', async () => {
    pageData.load.mockResolvedValue({ status: 'ready', data: {} })
    render(await MemoryPage())
    expect(screen.getByRole('heading', { name: '长期记忆管理' })).toBeInTheDocument()
  })

  it('explains fail-closed configuration without hydrating the workspace', async () => {
    pageData.load.mockResolvedValue({ status: 'configuration_invalid' })
    render(await MemoryPage())
    expect(screen.getByRole('alert')).toHaveTextContent('Memory policy 未注册')
  })
})
