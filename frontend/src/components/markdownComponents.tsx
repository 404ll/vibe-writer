import { Children, isValidElement, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import mermaid from 'mermaid'

let mermaidReady = false

function ensureMermaid() {
  if (mermaidReady) return
  mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' })
  mermaidReady = true
}

export function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const id = useId().replace(/:/g, '')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    ensureMermaid()
    if (!ref.current || !code.trim()) return

    let cancelled = false
    setFailed(false)
    mermaid
      .render(`mmd-${id}`, code.trim())
      .then(({ svg, bindFunctions }) => {
        if (cancelled || !ref.current) return
        ref.current.innerHTML = svg
        bindFunctions?.(ref.current)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [code, id])

  if (failed) {
    return (
      <pre
        style={{
          background: 'var(--input-bg)',
          border: '1px solid var(--border-input)',
          borderRadius: '6px',
          padding: '12px 16px',
          overflowX: 'auto',
          margin: '16px 0',
        }}
      >
        <code>{code}</code>
      </pre>
    )
  }

  return (
    <div
      ref={ref}
      className="mermaid-diagram"
      style={{ margin: '16px 0', overflowX: 'auto', minHeight: '48px' }}
    />
  )
}

function mermaidCodeFromPre(children: ReactNode): string | null {
  const arr = Children.toArray(children)
  if (arr.length !== 1 || !isValidElement(arr[0])) return null
  const child = arr[0] as React.ReactElement<{ className?: string; children?: ReactNode }>
  const cn = child.props.className ?? ''
  if (typeof cn === 'string' && cn.includes('language-mermaid')) {
    return String(child.props.children ?? '').replace(/\n$/, '').trim()
  }
  return null
}

export function slugifyHeading(text: string) {
  return text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '')
}

/** react-markdown 组件映射：正确处理 ```mermaid 围栏块 */
export function buildMarkdownComponents(withHeadingIds = false) {
  return {
    ...(withHeadingIds
      ? {
          h1: ({ children }: { children?: ReactNode }) => (
            <h1 id={slugifyHeading(String(children))}>{children}</h1>
          ),
          h2: ({ children }: { children?: ReactNode }) => (
            <h2 id={slugifyHeading(String(children))}>{children}</h2>
          ),
          h3: ({ children }: { children?: ReactNode }) => (
            <h3 id={slugifyHeading(String(children))}>{children}</h3>
          ),
        }
      : {}),
    pre({ children, ...props }: { children?: ReactNode }) {
      const mermaidCode = mermaidCodeFromPre(children)
      if (mermaidCode) return <MermaidBlock code={mermaidCode} />
      return <pre {...props}>{children}</pre>
    },
    code({ className, children, ...props }: { className?: string; children?: ReactNode }) {
      const lang = /language-(\w+)/.exec(className || '')?.[1]
      if (lang === 'mermaid') {
        return <MermaidBlock code={String(children).replace(/\n$/, '').trim()} />
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    },
  }
}
