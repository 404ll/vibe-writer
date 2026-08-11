import { render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { MermaidBlock } from './markdownComponents'

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn().mockResolvedValue({ svg: '<svg data-testid="diagram"></svg>' }),
}))

vi.mock('mermaid', () => ({
  default: mermaidMocks,
}))

it('loads Mermaid on demand and renders the diagram', async () => {
  const { container } = render(<MermaidBlock code="graph TD; A-->B" />)

  await waitFor(() => {
    expect(container.querySelector('[data-testid="diagram"]')).not.toBeNull()
  })
  expect(mermaidMocks.initialize).toHaveBeenCalledTimes(1)
  expect(mermaidMocks.render).toHaveBeenCalledWith(expect.stringMatching(/^mmd-/), 'graph TD; A-->B')
})
