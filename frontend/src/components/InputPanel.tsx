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

  return (
    <div style={{ padding: '1rem', borderBottom: '1px solid #eee' }}>
      <input
        placeholder="输入写作主题..."
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        style={{ width: '60%', marginRight: '0.5rem' }}
      />
      <label style={{ marginRight: '0.5rem' }}>
        <input
          type="checkbox"
          checked={onOutline}
          onChange={(e) => setOnOutline(e.target.checked)}
        />{' '}
        大纲后介入
      </label>
      <label style={{ marginRight: '0.5rem' }}>
        <input
          type="checkbox"
          checked={onChapter}
          onChange={(e) => setOnChapter(e.target.checked)}
        />{' '}
        每章后介入
      </label>
      <button
        onClick={() => onSubmit(topic, { on_outline: onOutline, on_chapter: onChapter })}
        disabled={disabled || !topic.trim()}
      >
        开始写作
      </button>
    </div>
  )
}
