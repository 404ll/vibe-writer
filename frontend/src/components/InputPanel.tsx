import { useState } from 'react'
import type { InterventionConfig } from '../types'

const PRESET_STYLES = ['技术博客', '科普', '教程', '自定义'] as const
type PresetStyle = typeof PRESET_STYLES[number] | ''

interface Props {
  onSubmit: (topic: string, intervention: InterventionConfig, style: string) => void
  disabled: boolean
}

export function InputPanel({ onSubmit, disabled }: Props) {
  const [topic, setTopic] = useState('')
  const [onOutline, setOnOutline] = useState(true)
  const [selectedStyle, setSelectedStyle] = useState<PresetStyle>('')
  const [customStyle, setCustomStyle] = useState('')

  function handleSubmit() {
    if (!topic.trim()) return
    const style = selectedStyle === '自定义' ? customStyle.trim() : selectedStyle
    onSubmit(topic, { on_outline: onOutline }, style)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', width: '100%', maxWidth: '620px', flexShrink: 0 }}>
      {/* Hero title */}
      <div style={{ fontFamily: 'var(--serif)', fontSize: '32px', color: 'var(--text-h)', letterSpacing: '0.3px', marginBottom: '2px' }}>
        vibe-writer
      </div>
      <div style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 300, marginBottom: '8px' }}>
        输入主题，AI 帮你写一篇完整文章
      </div>

    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '10px', flexShrink: 0, width: '100%', boxShadow: '0 4px 20px rgba(60,40,10,0.10)' }}>
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

      {/* 介入配置 + 风格选择 */}
      <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={onOutline}
            onChange={(e) => setOnOutline(e.target.checked)}
            disabled={disabled}
          />
          大纲生成后介入
        </label>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <label htmlFor="style-select" style={{ fontSize: '13px', color: 'var(--text)', whiteSpace: 'nowrap' }}>
            写作风格
          </label>
          <select
            id="style-select"
            value={selectedStyle}
            onChange={(e) => setSelectedStyle(e.target.value as PresetStyle)}
            disabled={disabled}
            style={{
              padding: '5px 28px 5px 10px',
              border: '1px solid var(--border-input)',
              borderRadius: '5px',
              fontSize: '13px',
              color: disabled ? 'var(--text-muted)' : 'var(--text-h)',
              background: `${disabled ? 'var(--input-bg)' : 'var(--card-bg)'} url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23a09880' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 9px center`,
              fontFamily: 'var(--sans)',
              cursor: disabled ? 'not-allowed' : 'pointer',
              appearance: 'none',
              WebkitAppearance: 'none',
              minWidth: '88px',
            }}
          >
            <option value="">不指定</option>
            {PRESET_STYLES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      {/* 自定义风格输入框 */}
      {selectedStyle === '自定义' && (
        <input
          type="text"
          placeholder="描述你想要的写作风格，例如：幽默风趣，多用类比…"
          value={customStyle}
          onChange={(e) => setCustomStyle(e.target.value)}
          disabled={disabled}
          style={{
            padding: '7px 12px',
            border: '1px solid var(--border-input)',
            borderRadius: '5px',
            fontSize: '13px',
            color: 'var(--text-h)',
            background: disabled ? 'var(--input-bg)' : 'var(--card-bg)',
            fontFamily: 'var(--sans)',
          }}
        />
      )}
    </div>
    </div>
  )
}
