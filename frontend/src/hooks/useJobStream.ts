import { useEffect, useRef } from 'react'
import type { SSEEventType } from '../types'

const API_BASE = 'http://localhost:8000'

// 需要监听的所有 SSE 事件类型（与后端 SSEEvent.event 字段保持一致）
const SSE_EVENT_TYPES: SSEEventType[] = [
  'stage_update',
  'outline_ready',
  'searching',
  'reviewing_chapter',
  'chapter_done',
  'reviewing_full',
  'review_done',
  'done',
  'error',
]

/**
 * 管理 SSE 长连接的自定义 Hook。
 *
 * @param jobId  - 要订阅的 Job ID；传 null 时不建立连接
 * @param onEvent - 收到事件时的回调，参数为 (事件类型, 解析后的 data 对象)
 *
 * 设计要点：
 * - 用 useRef 存储 onEvent，避免每次父组件 re-render 导致 EventSource 重建
 *   （stale closure 问题：如果直接在 addEventListener 里用 onEvent，
 *    闭包会捕获旧版本的函数；用 ref 则始终指向最新版本）
 * - jobId 变化时，旧连接自动关闭，新连接自动建立（useEffect 的清理函数）
 */
export function useJobStream(
  jobId: string | null,
  onEvent: (type: SSEEventType, data: Record<string, unknown>) => void
) {
  // ref 让 addEventListener 里的回调始终能调用到最新的 onEvent
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!jobId) return

    // 建立 SSE 长连接
    const es = new EventSource(`${API_BASE}/jobs/${jobId}/stream`)

    // 为每种事件类型分别注册监听器
    SSE_EVENT_TYPES.forEach((type) => {
      es.addEventListener(type, (e: MessageEvent) => {
        const data = JSON.parse(e.data)
        onEventRef.current(type, data)
      })
    })

    // 组件卸载或 jobId 变化时关闭连接，防止内存泄漏
    return () => es.close()
  }, [jobId])
}
