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
      style={{ borderLeft: '3px solid #2563eb', paddingLeft: '17px' }}
    >
      <h3 style={{ margin: '0 0 12px', fontSize: '15px', fontWeight: 600, color: '#0f172a' }}>
        大纲已生成，请确认
      </h3>
      <ol style={{ margin: '0 0 12px', paddingLeft: '20px', fontSize: '14px', color: '#334155', lineHeight: '1.8' }}>
        {outline.map((ch, i) => (
          <li key={i}>{ch}</li>
        ))}
      </ol>
      <p style={{ fontSize: '12px', color: '#94a3b8', margin: '0 0 10px' }}>
        如需调整，在下方输入修改意见；直接点击确认则按此大纲写作。
      </p>
      <textarea
        aria-label="修改意见"
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        placeholder="可选：输入修改意见，如「把第三章改成讲实战案例」"
        style={{
          width: '100%',
          height: '72px',
          marginBottom: '10px',
          padding: '8px 10px',
          border: '1px solid #e2e8f0',
          borderRadius: '4px',
          fontSize: '13px',
          resize: 'vertical',
          boxSizing: 'border-box',
          color: '#334155',
        }}
      />
      <button
        className="btn-primary"
        onClick={() => onConfirm(reply || '确认')}
      >
        确认继续
      </button>
    </div>
  )
}
