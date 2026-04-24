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
      style={{ borderLeft: '3px solid var(--accent)', paddingLeft: '13px', flexShrink: 0 }}
    >
      <div className="card-label">大纲确认</div>
      <h3 style={{ margin: '0 0 8px', fontSize: '14px', fontWeight: 500, color: 'var(--text-h)' }}>
        大纲已生成，请确认
      </h3>
      <ol style={{ margin: '0 0 8px', paddingLeft: '18px', fontSize: '13px', color: 'var(--text)', lineHeight: '1.85' }}>
        {outline.map((ch, i) => (
          <li key={i}>{ch}</li>
        ))}
      </ol>
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
