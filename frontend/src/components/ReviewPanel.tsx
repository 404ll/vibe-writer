import { useState } from 'react'

interface Props {
  outline: string[]
  onConfirm: (reply: string, outline: string[]) => void
}

export function ReviewPanel({ outline, onConfirm }: Props) {
  const [chapters, setChapters] = useState<string[]>(outline)
  const [reply, setReply] = useState('')

  function updateChapter(i: number, value: string) {
    setChapters((prev) => prev.map((ch, idx) => (idx === i ? value : ch)))
  }

  function deleteChapter(i: number) {
    if (chapters.length <= 1) return
    setChapters((prev) => prev.filter((_, idx) => idx !== i))
  }

  return (
    <div
      className="card"
      style={{ width: '100%', maxWidth: '620px', flexShrink: 0 }}
    >
      <div className="card-label">大纲确认</div>
      <p style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-h)', margin: '0 0 10px' }}>
        共 {chapters.length} 个章节，可直接编辑标题或删除章节
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' }}>
        {chapters.map((ch, i) => (
          <div
            key={i}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '4px 8px',
              background: 'var(--input-bg)',
              borderRadius: '6px',
            }}
          >
            <span style={{ fontSize: '9px', color: 'var(--text-label)', fontWeight: 600, width: '16px', flexShrink: 0 }}>
              {String(i + 1).padStart(2, '0')}
            </span>
            <input
              value={ch}
              onChange={(e) => updateChapter(i, e.target.value)}
              style={{
                flex: 1,
                border: 'none',
                background: 'transparent',
                fontSize: '12px',
                color: 'var(--text)',
                fontFamily: 'var(--sans)',
                outline: 'none',
                padding: '2px 0',
              }}
            />
            <button
              type="button"
              onClick={() => deleteChapter(i)}
              disabled={chapters.length <= 1}
              title="删除此章节"
              style={{
                border: 'none',
                background: 'none',
                cursor: chapters.length <= 1 ? 'not-allowed' : 'pointer',
                color: chapters.length <= 1 ? 'var(--text-label)' : 'var(--text-muted)',
                fontSize: '14px',
                lineHeight: 1,
                padding: '2px 4px',
                flexShrink: 0,
                opacity: chapters.length <= 1 ? 0.3 : 1,
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 8px' }}>
        还可在下方输入修改建议，AI 会在此基础上进一步调整。
      </p>
      <textarea
        aria-label="修改意见"
        name="feedback"
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        placeholder="可选：如「在第二章后加一章讲实战案例」…"
        style={{
          width: '100%',
          height: '56px',
          marginBottom: '8px',
          padding: '7px 10px',
          border: '1px solid var(--border-input)',
          borderRadius: '5px',
          fontSize: '13px',
          resize: 'vertical',
          boxSizing: 'border-box',
          color: 'var(--text)',
          background: 'var(--input-bg)',
          fontFamily: 'var(--sans)',
        }}
      />
      <button
        type="button"
        className="btn-primary"
        onClick={() => onConfirm(reply, chapters)}
      >
        确认继续
      </button>
    </div>
  )
}
