import { useEffect, useRef } from 'react'

const WINDOW_SIZE = 180

interface Props {
  title: string
  buffer: string
}

export function WritingPreview({ title, buffer }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [buffer])

  const windowed = buffer.length > WINDOW_SIZE ? buffer.slice(-WINDOW_SIZE) : buffer

  return (
    <div className="card writing-preview">
      <div className="writing-preview-header">
        <div className="writing-preview-left">
          <span className="writing-pulse" />
          <span className="writing-title">{title}</span>
        </div>
        <span className="writing-badge">写作中</span>
      </div>

      <div ref={containerRef} className="writing-buffer">
        <div className="writing-fade" />
        <p className="writing-text">
          {windowed}
          <span className="writing-cursor" />
        </p>
      </div>
    </div>
  )
}
