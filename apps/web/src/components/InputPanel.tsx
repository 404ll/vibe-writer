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
    <div className="input-panel">
      <div className="hero-kicker">AI Writing Workbench</div>
      <div className="terminal-title">vibe-writer</div>
      <div className="terminal-subtitle">输入主题，生成结构完整、可编辑的技术文章。</div>

      <div className="card input-card">
        <div className="card-label">写作控制台</div>
        <div className="command-row">
          <label htmlFor="topic-input" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
            写作主题
          </label>
          <input
            id="topic-input"
            className="terminal-field topic-input"
            type="text"
            name="topic"
            placeholder="输入写作主题，例如：RAG 检索增强生成…"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            autoComplete="off"
            disabled={disabled}
          />
          <button
            type="button"
            className="btn-primary topic-submit"
            onClick={handleSubmit}
            disabled={disabled || !topic.trim()}
          >
            开始写作
          </button>
        </div>

        <div className="terminal-divider" />

        <div className="option-row">
          <span className="option-label">大纲介入</span>
          {(['开启', '关闭'] as const).map((opt) => {
            const isOn = opt === '开启'
            const active = onOutline === isOn
            return (
              <button
                key={opt}
                type="button"
                onClick={() => !disabled && setOnOutline(isOn)}
                disabled={disabled}
                className={active ? 'terminal-pill terminal-pill--active' : 'terminal-pill'}
              >
                {active && opt === '开启' ? '✓ 开启' : opt}
              </button>
            )
          })}
        </div>

        <div className="option-row">
          <span className="option-label">写作风格</span>
          {(['', ...PRESET_STYLES] as const).map((opt) => {
            const label = opt === '' ? '不指定' : opt
            const active = selectedStyle === opt
            return (
              <button
                key={label}
                type="button"
                onClick={() => !disabled && setSelectedStyle(opt as PresetStyle)}
                disabled={disabled}
                className={active ? 'terminal-pill terminal-pill--active' : 'terminal-pill'}
              >
                {label}
              </button>
            )
          })}
        </div>

        <div className="option-row">
          <span className="option-label">篇幅</span>
          {WORD_COUNT_OPTIONS.map((opt) => {
            const active = targetWords === opt.words
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => !disabled && setTargetWords(opt.words)}
                disabled={disabled}
                className={active ? 'terminal-pill terminal-pill--active' : 'terminal-pill'}
              >
                {opt.words ? `${opt.label}（~${opt.words}字）` : opt.label}
              </button>
            )
          })}
        </div>

        {selectedStyle === '自定义' && (
          <input
            className="terminal-field custom-style-input"
            type="text"
            placeholder="描述你想要的写作风格，例如：幽默风趣，多用类比…"
            value={customStyle}
            onChange={(e) => setCustomStyle(e.target.value)}
            disabled={disabled}
          />
        )}
      </div>
    </div>
  )
}
