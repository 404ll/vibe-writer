# Phase 5a 设计文档：断点续写（Reconnect & Replay）

**日期：** 2026-04-24
**状态：** 待实现

---

## 目标

用户关闭窗口后 agent 继续在后端运行。重新打开页面时，前端能完整恢复：当前阶段、大纲、活动日志历史。

---

## 决策记录

- **历史存储位置：后端 `event_log`**，不用 localStorage。理由：localStorage 只能恢复同一浏览器，且无法应对服务端重启后 job 仍在跑的场景；后端 event_log 是唯一可信来源。
- **回放接口：`GET /jobs/{id}/events`**，返回 `event_log` 列表，前端重连时先 fetch 再接 SSE 流。
- **event_log 存内存**，不持久化到磁盘（Phase 5 范围内不做持久化，服务器重启后 job 丢失是可接受的）。

---

## 一、后端变更

### 1.1 `backend/store.py`

`JobStore` 新增第四张表：

```python
self._event_logs: dict[str, list[SSEEvent]] = {}
```

`create_job` 时初始化：

```python
self._event_logs[job.id] = []
```

新增方法：

```python
def append_event(self, job_id: str, event: SSEEvent):
    """追加事件到历史日志"""
    if job_id in self._event_logs:
        self._event_logs[job_id].append(event)

def get_events(self, job_id: str) -> list[SSEEvent]:
    """返回该 job 的全部历史事件"""
    return self._event_logs.get(job_id, [])
```

### 1.2 `backend/routers/jobs.py`

**`push_event` 同时写入 event_log：**

```python
async def push_event(job_id: str, event: SSEEvent):
    job_store.append_event(job_id, event)   # ← 新增
    queue = _stream_queues.get(job_id)
    if queue:
        await queue.put(event)
```

**新增 `GET /jobs/{job_id}/events` 端点：**

```python
@router.get("/{job_id}/events")
async def get_job_events(job_id: str):
    job = job_store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    events = job_store.get_events(job_id)
    return {"events": [{"event": e.event, "data": e.data} for e in events]}
```

**修复遗留 bug：** `_run_agent` 中删除已不存在的 `intervention_on_chapter` 参数：

```python
orch = Orchestrator(
    job_id=job_id,
    topic=job.topic,
    intervention_on_outline=job.intervention.on_outline,
)
```

### 1.3 `backend/models.py`

无需修改。

---

## 二、前端变更

### 2.1 `frontend/src/hooks/useJobStream.ts`

重连时先 fetch 历史事件再订阅 SSE：

```typescript
// 伪代码结构
useEffect(() => {
  if (!jobId) return

  let es: EventSource | null = null
  let cancelled = false

  async function connect() {
    // 1. 回放历史事件
    const res = await fetch(`${API_BASE}/jobs/${jobId}/events`)
    if (!res.ok || cancelled) return
    const { events } = await res.json()
    for (const e of events) {
      onEvent(e.event, e.data)
    }

    // 2. 接 SSE 流（只接新事件）
    if (cancelled) return
    es = new EventSource(`${API_BASE}/jobs/${jobId}/stream`)
    es.addEventListener('message', ...)
    // ... 其余与现有逻辑相同
  }

  connect()
  return () => { cancelled = true; es?.close() }
}, [jobId])
```

关键点：
- `cancelled` flag 防止组件卸载后的回调执行
- 历史回放与 SSE 流之间可能有短暂重叠（同一事件被处理两次）。`App.tsx` 的 `handleEvent` 是幂等的（stage_update 覆盖写、activity log append），重复处理不影响正确性，不需要去重。

### 2.2 `frontend/src/App.tsx`

无需修改（`handleEvent` 已经能处理所有事件类型）。

---

## 三、文件变更清单

| 文件 | 变更 |
|------|------|
| `backend/store.py` | 新增 `_event_logs`、`append_event`、`get_events` |
| `backend/routers/jobs.py` | `push_event` 写 event_log；新增 `/events` 端点；删除 `intervention_on_chapter` bug |
| `frontend/src/hooks/useJobStream.ts` | 重连前先 fetch `/events` 回放历史 |

---

## 四、不在本次范围内

- event_log 持久化到磁盘（服务器重启后恢复）
- SSE 断线后自动重连的 UI 提示
- 历史事件去重（当前幂等处理足够）
