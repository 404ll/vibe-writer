import { Children, isValidElement, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import mermaid from 'mermaid'

let mermaidReady = false

/**
 * Mermaid 的配置是模块级全局状态，整个页面生命周期只初始化一次。
 * `startOnLoad: false` 表示由 React 在组件挂载后主动触发渲染，避免 Mermaid
 * 自己扫描并修改尚未交给 React 管理的 DOM。
 */
function ensureMermaid() {
  if (mermaidReady) return
  mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' })
  mermaidReady = true
}

/**
 * 把单个 Mermaid fenced code block 渲染成 SVG。
 * Mermaid 需要真实 DOM，因此通过 ref 获取容器，并在 effect 中执行异步渲染；
 * 若语法错误则保留原始代码，避免一张图导致整篇 Markdown 无法阅读。
 */
export function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null)
  // 同一篇文章可能包含多张图，Mermaid 要求每次 render 使用唯一 id。
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
        // effect 清理后忽略迟到的异步结果，避免写入已经卸载或复用的 DOM。
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

/**
 * react-markdown 通常会把 fenced code block 转成 `<pre><code /></pre>`。
 * 这里在 pre 层识别 `language-mermaid`，把图表源码交给 MermaidBlock；
 * 普通代码块返回 null，继续走 react-markdown 的默认渲染。
 */
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

/** 将 Markdown 标题转换成目录链接和正文 heading 共用的锚点。 */
export function slugifyHeading(text: string) {
  return text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * 创建 react-markdown 的组件映射。
 * 阅读态开启 heading id，供文章目录定位和 IntersectionObserver 追踪；
 * 编辑及历史预览关闭 heading id，避免同一页面出现重复 DOM id。
 * pre/code 两层都兼容 Mermaid，是为了覆盖 react-markdown 对块级代码的节点包装差异。
 */
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
