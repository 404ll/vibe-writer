import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import HomePage from './page'

const durable = vi.hoisted(() => ({ api: vi.fn(), memory: vi.fn() }))

vi.mock('../src/server/durableDatabase', () => ({
  durableApiEnabled: durable.api,
  durableMemoryManagementApiEnabled: durable.memory,
}))

vi.mock('../src/components/WritingWorkspace', () => ({
  WritingWorkspace: ({ memoryManagementEnabled }: { memoryManagementEnabled: boolean }) => (
    <div>
      <h1>写作工作台</h1>
      <span>{memoryManagementEnabled ? 'memory-on' : 'memory-off'}</span>
    </div>
  ),
}))

it('renders the writing workspace at the root App Router page', () => {
  durable.api.mockReturnValue(true)
  durable.memory.mockReturnValue(true)
  render(<HomePage />)
  expect(screen.getByRole('heading', { name: '写作工作台' })).toBeInTheDocument()
  expect(screen.getByText('memory-on')).toBeInTheDocument()
})
