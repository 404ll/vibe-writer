import { Children, isValidElement, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { slugifyHeading } from './markdownUtils'

type MermaidApi = typeof import('mermaid')['default']

/**
 * Mermaid 只在浏览器真正遇到图表时才动态加载，避免进入服务端渲染链路。
 * 模块级 Promise 会被所有 MermaidBlock 复用，因此配置在页面生命周期内只初始化一次。
 * `startOnLoad: false` 表示由 React 挂载后主动渲染，不让 Mermaid 自行扫描和修改 DOM。
 */
let mermaidPromise: Promise<MermaidApi> | null = null

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' })
      return mermaid
    })
  }
  return mermaidPromise
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
    if (!ref.current || !code.trim()) return

    let cancelled = false
    setFailed(false)
    loadMermaid()
      .then((mermaid) => mermaid.render(`mmd-${id}`, code.trim()))
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

/**
 * 固定普通 Markdown 的组件映射引用，并在 pre/code 两层兼容 Mermaid 围栏代码块。
 * react-markdown 的节点包装可能因代码块形态而落到其中任意一层。
 */
const markdownComponents = {
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

/** 阅读态额外生成 heading id，供文章目录链接和滚动位置观察共用。 */
const markdownComponentsWithHeadings = {
  ...markdownComponents,
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

/**
 * 统一文章阅读、编辑预览和历史预览的 Markdown/GFM/Mermaid 渲染入口。
 * 编辑和历史预览不开启 heading id，避免它们与正文同时出现时产生重复 DOM id。
 */
export function MarkdownContent({
  children,
  withHeadingIds = false,
}: {
  children: string
  withHeadingIds?: boolean
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={withHeadingIds ? markdownComponentsWithHeadings : markdownComponents}
    >
      {children}
    </ReactMarkdown>
  )
}
