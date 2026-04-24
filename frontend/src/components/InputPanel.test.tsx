import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InputPanel } from './InputPanel'

describe('InputPanel', () => {
  it('calls onSubmit with topic and intervention config', () => {
    const onSubmit = vi.fn()
    render(<InputPanel onSubmit={onSubmit} disabled={false} />)

    fireEvent.change(screen.getByPlaceholderText('输入写作主题，例如：RAG 检索增强生成…'), {
      target: { value: 'AI Agents 入门' },
    })
    fireEvent.click(screen.getByText('开始写作'))

    expect(onSubmit).toHaveBeenCalledWith(
      'AI Agents 入门',
      { on_outline: true }
    )
  })

  it('disables submit button when disabled=true', () => {
    render(<InputPanel onSubmit={vi.fn()} disabled={true} />)
    expect(screen.getByText('开始写作')).toBeDisabled()
  })
})
