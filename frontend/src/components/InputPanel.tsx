import { useState } from 'react'
import type { InterventionConfig } from '../types'
import { WORD_COUNT_OPTIONS } from '../types'

const PRESET_STYLES = ['技术博客', '科普', '教程', '自定义'] as const
type PresetStyle = typeof PRESET_STYLES[number] | ''

interface Props {
  onSubmit: (topic: string, intervention: InterventionConfig, style: string, targetWords: number | null) => void
  disabled: boolean
}

export function InputPanel({ onSubmit, disabled }: Props) {
  const [topic, setTopic] = useState('')
  const [onOutline, setOnOutline] = useState(true)
  const [selectedStyle, setSelectedStyle] = useState<PresetStyle>('')
  const [customStyle, setCustomStyle] = useState('')
  const [targetWords, setTargetWords] = useState<number | null>(null)

  function handleSubmit() {
    if (!topic.trim()) return
    const style = selectedStyle === '自定义' ? customStyle.trim() : selectedStyle
    onSubmit(topic, { on_outline: onOutline }, style, targetWords)
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

      {/* 分隔线 */}
      <div style={{ height: '1px', background: 'var(--border)', margin: '0 -2px' }} />

      {/* 介入配置 — pill 行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '11px', color: 'var(--text-label)', fontWeight: 500, width: '52px', flexShrink: 0 }}>大纲介入</span>
        {(['开启', '关闭'] as const).map((opt) => {
          const isOn = opt === '开启'
          const active = onOutline === isOn
          return (
            <button
              key={opt}
              type="button"
              onClick={() => !disabled && setOnOutline(isOn)}
              disabled={disabled}
              style={{
                padding: '3px 10px',
                borderRadius: '99px',
                fontSize: '12px',
                border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border-input)'}`,
                color: active ? 'var(--card-bg)' : 'var(--text)',
                background: active ? 'var(--accent)' : 'var(--input-bg)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--sans)',
                transition: 'all 0.15s',
                opacity: disabled ? 0.6 : 1,
              }}
            >
              {active && opt === '开启' ? '✓ 开启' : opt}
            </button>
          )
        })}
      </div>

      {/* 写作风格 — pill 行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '11px', color: 'var(--text-label)', fontWeight: 500, width: '52px', flexShrink: 0 }}>写作风格</span>
        {(['', ...PRESET_STYLES] as const).map((opt) => {
          const label = opt === '' ? '不指定' : opt
          const active = selectedStyle === opt
          return (
            <button
              key={label}
              type="button"
              onClick={() => !disabled && setSelectedStyle(opt as PresetStyle)}
              disabled={disabled}
              style={{
                padding: '3px 10px',
                borderRadius: '99px',
                fontSize: '12px',
                border: `1.5px solid ${active ? 'var(--accent-active)' : 'var(--border-input)'}`,
                color: active ? 'var(--accent-active)' : 'var(--text)',
                background: active ? '#fff3e8' : 'var(--input-bg)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--sans)',
                transition: 'all 0.15s',
                opacity: disabled ? 0.6 : 1,
              }}
            >
              {label}
            </button>
          )
        })}
      </div>

      {/* 篇幅限制 — pill 行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '11px', color: 'var(--text-label)', fontWeight: 500, width: '52px', flexShrink: 0 }}>篇幅</span>
        {WORD_COUNT_OPTIONS.map((opt) => {
          const active = targetWords === opt.words
          return (
            <button
              key={opt.label}
              type="button"
              onClick={() => !disabled && setTargetWords(opt.words)}
              disabled={disabled}
              style={{
                padding: '3px 10px',
                borderRadius: '99px',
                fontSize: '12px',
                border: `1.5px solid ${active ? 'var(--accent-active)' : 'var(--border-input)'}`,
                color: active ? 'var(--accent-active)' : 'var(--text)',
                background: active ? '#fff3e8' : 'var(--input-bg)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--sans)',
                transition: 'all 0.15s',
                opacity: disabled ? 0.6 : 1,
              }}
            >
              {opt.words ? `${opt.label}（~${opt.words}字）` : opt.label}
            </button>
          )
        })}
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
