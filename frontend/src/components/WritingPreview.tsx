import { useEffect, useRef } from 'react'

const WINDOW_SIZE = 180 // 滑动窗口保留的最大字符数

interface Props {
  title: string
  buffer: string
}

export function WritingPreview({ title, buffer }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  // 每次 buffer 更新时滚动到底部
  useEffect(() => {
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [buffer])

  // 滑动窗口：只保留最后 WINDOW_SIZE 个字符
  const windowed = buffer.length > WINDOW_SIZE ? buffer.slice(-WINDOW_SIZE) : buffer

  return (
    <div
      className="card"
      style={{
        width: '100%',
        maxWidth: '620px',
        flexShrink: 0,
        padding: '10px 14px',
        overflow: 'hidden',
        borderTop: '2px solid var(--accent-active)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          {/* 写作中的脉冲点 */}
          <span style={{
            width: '6px', height: '6px',
            borderRadius: '50%',
            background: 'var(--accent-active)',
            flexShrink: 0,
            animationName: 'pulse-dot',
            animationDuration: '1s',
            animationTimingFunction: 'ease-in-out',
            animationIterationCount: 'infinite',
          }} />
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </span>
        </div>
        <span style={{
          fontSize: '9px', fontWeight: 600, letterSpacing: '0.5px',
          textTransform: 'uppercase',
          background: '#fff3e8', color: 'var(--accent-active)',
          border: '1px solid #fdd0a8',
          borderRadius: '99px', padding: '1px 7px',
          flexShrink: 0, marginLeft: '8px',
        }}>
          写作中
        </span>
      </div>

      <div
        ref={containerRef}
        style={{
          height: '52px',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {/* 顶部渐隐遮罩，制造文字"滚出"的效果 */}
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0,
          height: '20px',
          background: 'linear-gradient(to bottom, var(--card-bg), transparent)',
          zIndex: 1,
          pointerEvents: 'none',
        }} />
        <p style={{
          margin: 0,
          fontSize: '12.5px',
          lineHeight: '1.6',
          color: 'var(--text)',
          fontFamily: 'var(--sans)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}>
          {windowed}
          {/* 光标闪烁 */}
          <span style={{
            display: 'inline-block',
            width: '1px',
            height: '13px',
            background: 'var(--accent)',
            marginLeft: '1px',
            verticalAlign: 'text-bottom',
            animationName: 'blink',
            animationDuration: '0.8s',
            animationTimingFunction: 'step-end',
            animationIterationCount: 'infinite',
          }} />
        </p>
      </div>

      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          @keyframes pulse-dot {
            0%, 100% { opacity: 1; transform: scale(1); }
            50%       { opacity: 0.4; transform: scale(0.7); }
          }
          @keyframes blink {
            0%, 100% { opacity: 1; }
            50%       { opacity: 0; }
          }
        }
      `}</style>
    </div>
  )
}
