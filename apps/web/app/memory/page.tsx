import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { MemoryManagementWorkspace } from '@/components/memory/MemoryManagementWorkspace'
import { loadMemoryManagementPageData } from '@/server/memory/memoryManagementPageData'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Memory 管理 | Vibe Writer',
  description: '查看、审核和删除 Vibe Writer 长期记忆',
}

const STATUS_COPY = {
  disabled: ['Memory 管理未启用', '该管理平面仍处于默认关闭的 staging 状态。'],
  configuration_invalid: ['Memory policy 未注册', '当前配置没有对应的版本化 consent policy。'],
  auth_unconfigured: ['认证尚未配置', '必须由可信代理注入当前用户和工作区身份。'],
  unauthenticated: ['需要登录', '当前请求没有可验证的用户和工作区身份。'],
  forbidden: ['无权访问', '你不是当前工作区的有效成员。'],
  dependency_unavailable: ['Memory 暂时不可用', '数据依赖不可用，请稍后重试。'],
} as const

export default async function MemoryPage() {
  const result = await loadMemoryManagementPageData(await headers())
  if (result.status === 'ready') {
    return <MemoryManagementWorkspace initialData={result.data} />
  }
  if (result.status === 'disabled') notFound()
  const [title, detail] = STATUS_COPY[result.status]
  return (
    <div className="memory-shell">
      <header className="memory-nav">
        <Link href="/" className="ghost-button memory-back-link">返回写作</Link>
      </header>
      <main className="memory-state-card card" role="alert">
        <p className="card-label">MEMORY / UNAVAILABLE</p>
        <h1>{title}</h1>
        <p>{detail}</p>
      </main>
    </div>
  )
}
