import { useState } from 'react'

interface Props {
  outline: string[]
  onConfirm: (reply: string) => void
}

export function ReviewPanel({ outline, onConfirm }: Props) {
  const [reply, setReply] = useState('')

  return (
    <div style={{ padding: '1rem', border: '1px solid #2196f3', borderRadius: '4px', margin: '1rem' }}>
      <h3>大纲已生成，请确认</h3>
      <ol>
        {outline.map((ch, i) => (
          <li key={i}>{ch}</li>
        ))}
      </ol>
      <p style={{ color: '#666', fontSize: '0.9em' }}>
        如需调整，在下方输入修改意见；直接点击确认继续则按此大纲写作。
      </p>
      <textarea
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        placeholder="可选：输入修改意见，如「把第三章改成讲实战案例」"
        style={{ width: '100%', height: '80px', marginBottom: '0.5rem' }}
      />
      <button onClick={() => onConfirm(reply || '确认')}>
        确认继续
      </button>
    </div>
  )
}
