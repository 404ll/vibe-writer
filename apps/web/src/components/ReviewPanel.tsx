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
    <div className="card review-card">
      <div className="card-label">大纲确认</div>
      <p className="review-meta">共 {chapters.length} 个章节，可直接编辑标题或删除章节</p>

      <div className="outline-list">
        {chapters.map((ch, i) => (
          <div key={i} className="outline-row">
            <span className="outline-number">{String(i + 1).padStart(2, '0')}</span>
            <input
              className="outline-input"
              value={ch}
              onChange={(e) => updateChapter(i, e.target.value)}
            />
            <button
              type="button"
              onClick={() => deleteChapter(i)}
              disabled={chapters.length <= 1}
              title="删除此章节"
              className="outline-delete"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <p className="review-help">还可在下方输入修改建议，AI 会在此基础上进一步调整。</p>
      <textarea
        aria-label="修改意见"
        name="feedback"
        className="terminal-field review-feedback"
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        placeholder="可选：如「在第二章后加一章讲实战案例」…"
      />
      <button type="button" className="btn-primary" onClick={() => onConfirm(reply, chapters)}>
        确认继续
      </button>
    </div>
  )
}
