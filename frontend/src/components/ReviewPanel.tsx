import { useState } from 'react'

interface Props {
  outline: string[]
  onConfirm: (reply: string) => void
}

export function ReviewPanel({ outline, onConfirm }: Props) {
  const [reply, setReply] = useState('')

  return (
    <div
      className="card"
      style={{ width: '100%', maxWidth: '620px', flexShrink: 0 }}
    >
      <div className="card-label">大纲确认</div>
      <p style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-h)', margin: '0 0 10px' }}>
        共 {outline.length} 个章节，确认后开始写作
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' }}>
        {outline.map((ch, i) => (
          <div
            key={i}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '5px 8px',
              background: 'var(--input-bg)',
              borderRadius: '6px',
              fontSize: '12px', color: 'var(--text)',
            }}
          >
            <span style={{ fontSize: '9px', color: 'var(--text-label)', fontWeight: 600, width: '16px', flexShrink: 0 }}>
              {String(i + 1).padStart(2, '0')}
            </span>
            {ch}
          </div>
        ))}
      </div>
      <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 8px' }}>
        如需调整，在下方输入修改意见；直接点击确认则按此大纲写作。
      </p>
      <textarea
        aria-label="修改意见"
        name="feedback"
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        placeholder="可选：输入修改意见，如「把第三章改成讲实战案例」…"
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
        onClick={() => onConfirm(reply || '确认')}
      >
        确认继续
      </button>
    </div>
  )
}
