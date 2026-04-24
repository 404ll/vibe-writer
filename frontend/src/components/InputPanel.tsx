import { useState } from 'react'
import type { InterventionConfig } from '../types'

interface Props {
  onSubmit: (topic: string, intervention: InterventionConfig) => void
  disabled: boolean
}

export function InputPanel({ onSubmit, disabled }: Props) {
  const [topic, setTopic] = useState('')
  const [onOutline, setOnOutline] = useState(true)
  const [onChapter, setOnChapter] = useState(false)

  function handleSubmit() {
    if (!topic.trim()) return
    onSubmit(topic, { on_outline: onOutline, on_chapter: onChapter })
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '10px', flexShrink: 0 }}>
      <div className="card-label">写作主题</div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <label htmlFor="topic-input" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
          写作主题
        </label>
        <input
          id="topic-input"
          type="text"
          name="topic"
          placeholder="输入写作主题，例如：RAG 检索增强生成…"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          autoComplete="search"
          disabled={disabled}
          style={{
            flex: 1,
            minWidth: 0,
            padding: '8px 12px',
            border: '1px solid var(--border-input)',
            borderRadius: '5px',
            fontSize: '14px',
            color: 'var(--text-h)',
            background: disabled ? 'var(--input-bg)' : 'var(--card-bg)',
            fontFamily: 'var(--sans)',
          }}
        />
        <button
          type="button"
          className="btn-primary"
          onClick={handleSubmit}
          disabled={disabled || !topic.trim()}
        >
          开始写作
        </button>
      </div>
      <div style={{ display: 'flex', gap: '20px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={onOutline}
            onChange={(e) => setOnOutline(e.target.checked)}
            disabled={disabled}
          />
          大纲生成后介入
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={onChapter}
            onChange={(e) => setOnChapter(e.target.checked)}
            disabled={disabled}
          />
          每章完成后介入
        </label>
      </div>
    </div>
  )
}
