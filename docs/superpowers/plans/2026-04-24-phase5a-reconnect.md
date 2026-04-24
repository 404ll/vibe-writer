# Phase 5a: Reconnect & Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户重连后，前端通过 `GET /jobs/{id}/events` 回放历史事件，完整恢复阶段状态和活动日志。

**Architecture:** 后端 `JobStore` 新增 `_event_logs` 表，`push_event` 同时写入历史；新增 `/events` 端点供前端重连时一次性拉取；前端 `useJobStream` 先 fetch 历史再接 SSE 流。同时修复 `jobs.py` 中遗留的 `intervention_on_chapter` bug。

**Tech Stack:** Python asyncio, FastAPI, React 18, TypeScript

---

## File Map

| 文件 | 变更 |
|------|------|
| `backend/store.py` | 新增 `_event_logs`、`append_event()`、`get_events()` |
| `backend/routers/jobs.py` | `push_event` 写 event_log；新增 `GET /{id}/events`；删除 `intervention_on_chapter` bug |
| `frontend/src/hooks/useJobStream.ts` | 重连前先 fetch `/events` 回放历史 |
| `tests/test_store.py` | 新建：测试 event_log 功能 |
| `tests/test_jobs_router.py` | 新建：测试 `/events` 端点 |

---

## Task 1: 后端 — JobStore event_log

**Files:**
- Modify: `backend/store.py`
- Create: `tests/test_store.py`

- [ ] **Step 1: 新建 tests/test_store.py，写失败测试**

```python
# tests/test_store.py
import pytest
from backend.store import JobStore
from backend.models import SSEEvent

def test_event_log_empty_on_create():
    store = JobStore()
    job = store.create_job("测试主题")
    assert store.get_events(job.id) == []

def test_append_event_stores_event():
    store = JobStore()
    job = store.create_job("测试主题")
    event = SSEEvent(event="stage_update", data={"stage": "plan"})
    store.append_event(job.id, event)
    events = store.get_events(job.id)
    assert len(events) == 1
    assert events[0].event == "stage_update"

def test_append_multiple_events_preserves_order():
    store = JobStore()
    job = store.create_job("测试主题")
    store.append_event(job.id, SSEEvent(event="stage_update", data={"stage": "plan"}))
    store.append_event(job.id, SSEEvent(event="outline_ready", data={"outline": ["章节一"]}))
    store.append_event(job.id, SSEEvent(event="done", data={}))
    events = store.get_events(job.id)
    assert [e.event for e in events] == ["stage_update", "outline_ready", "done"]

def test_get_events_unknown_job_returns_empty():
    store = JobStore()
    assert store.get_events("nonexistent-id") == []
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_store.py -v
```
Expected: FAIL（`append_event` / `get_events` 不存在）

- [ ] **Step 3: 修改 backend/store.py**

将 `backend/store.py` 完整替换为：

```python
import asyncio
from typing import Optional
from backend.models import JobState, JobRequest, InterventionConfig, SSEEvent

class JobStore:
    """
    内存中的 Job 状态存储。

    每个 Job 有四张表：
    - _jobs:         job_id → JobState，保存完整状态
    - _reply_events: job_id → asyncio.Event，用于阻塞等待用户回复
    - _replies:      job_id → str，保存用户最新回复内容
    - _event_logs:   job_id → list[SSEEvent]，保存历史事件供重连回放

    设计模式：Singleton（模块底部的 job_store 实例）
    单进程单线程（asyncio），不需要加锁。
    """

    def __init__(self):
        self._jobs: dict[str, JobState] = {}
        self._reply_events: dict[str, asyncio.Event] = {}
        self._replies: dict[str, str] = {}
        self._event_logs: dict[str, list[SSEEvent]] = {}

    def create_job(self, topic: str, intervention=None) -> JobState:
        """创建新 Job，分配 UUID，初始化对应的 asyncio.Event 和 event_log"""
        job = JobState(
            topic=topic,
            intervention=intervention or InterventionConfig(),
        )
        self._jobs[job.id] = job
        self._reply_events[job.id] = asyncio.Event()
        self._event_logs[job.id] = []
        return job

    def get(self, job_id: str) -> Optional[JobState]:
        """按 ID 查询 Job，不存在返回 None"""
        return self._jobs.get(job_id)

    def update(self, job: JobState):
        """用新状态覆盖存储中的 Job（Orchestrator 每个阶段结束后调用）"""
        self._jobs[job.id] = job

    def set_reply(self, job_id: str, message: str):
        """
        保存用户回复并触发对应的 Event。
        Orchestrator 中 await wait_for_reply() 会在此处被唤醒。
        """
        self._replies[job_id] = message
        if job_id in self._reply_events:
            self._reply_events[job_id].set()

    def get_reply(self, job_id: str) -> Optional[str]:
        """同步读取最新回复（不阻塞）"""
        return self._replies.get(job_id)

    async def wait_for_reply(self, job_id: str) -> str:
        """
        阻塞等待用户回复。
        Orchestrator 在介入节点调用此方法，协程挂起；
        当前端 POST /reply 触发 set_reply() 后，Event 被 set，协程恢复。
        """
        event = self._reply_events.get(job_id)
        if event:
            await event.wait()
        return self._replies.get(job_id, "")

    def append_event(self, job_id: str, event: SSEEvent):
        """追加事件到历史日志，供重连时回放"""
        if job_id in self._event_logs:
            self._event_logs[job_id].append(event)

    def get_events(self, job_id: str) -> list[SSEEvent]:
        """返回该 job 的全部历史事件"""
        return self._event_logs.get(job_id, [])

# 全局单例，供 routers 和 orchestrator 共享同一份状态
job_store = JobStore()
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_store.py -v
```
Expected: 4 passed

- [ ] **Step 5: 运行全量测试确认无回归**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/ -v 2>&1 | tail -5
```
Expected: 28 passed

- [ ] **Step 6: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add backend/store.py tests/test_store.py
git commit -m "feat: add event_log to JobStore for reconnect replay"
```

---

## Task 2: 后端 — /events 端点 + push_event 写日志 + bug 修复

**Files:**
- Modify: `backend/routers/jobs.py`
- Create: `tests/test_jobs_router.py`

- [ ] **Step 1: 新建 tests/test_jobs_router.py，写失败测试**

```python
# tests/test_jobs_router.py
import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, AsyncMock
from backend.main import app
from backend.store import JobStore
from backend.models import SSEEvent

@pytest.fixture
def client():
    return TestClient(app)

def test_get_events_returns_empty_for_new_job(client):
    """新建 job 后 /events 返回空列表"""
    res = client.post("/jobs", json={"topic": "测试主题", "intervention": {"on_outline": False}})
    job_id = res.json()["job_id"]
    events_res = client.get(f"/jobs/{job_id}/events")
    assert events_res.status_code == 200
    assert events_res.json()["events"] == []

def test_get_events_returns_404_for_unknown_job(client):
    res = client.get("/jobs/nonexistent-id/events")
    assert res.status_code == 404

def test_push_event_writes_to_event_log():
    """push_event 调用后，event_log 中有对应记录"""
    import asyncio
    from backend.routers.jobs import push_event
    from backend.store import job_store

    store = JobStore()
    job = store.create_job("测试主题")

    with patch("backend.routers.jobs.job_store", store):
        event = SSEEvent(event="stage_update", data={"stage": "plan"})
        asyncio.get_event_loop().run_until_complete(push_event(job.id, event))

    events = store.get_events(job.id)
    assert len(events) == 1
    assert events[0].event == "stage_update"
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_jobs_router.py -v
```
Expected: FAIL（`/events` 端点不存在，`push_event` 未写日志）

- [ ] **Step 3: 修改 backend/routers/jobs.py**

将 `backend/routers/jobs.py` 完整替换为：

```python
import asyncio
import json
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from backend.models import JobRequest, ReplyRequest, SSEEvent
from backend.store import job_store

router = APIRouter(prefix="/jobs")

@router.post("")
async def create_job(req: JobRequest):
    """
    创建写作任务并立即返回 job_id。
    Agent 以后台 Task 形式异步运行，不阻塞本次 HTTP 响应。
    前端拿到 job_id 后立刻连接 /stream 接收进度事件。
    """
    job = job_store.create_job(req.topic, req.intervention)
    asyncio.create_task(_run_agent(job.id))
    return {"job_id": job.id}

@router.get("/{job_id}/stream")
async def stream_job(job_id: str):
    """
    SSE（Server-Sent Events）长连接端点。
    前端通过 EventSource 订阅，每当 Orchestrator 调用 push_event()，
    事件就会实时推送到浏览器。

    协议格式：
        event: <事件类型>
        data: <JSON 字符串>
    """
    job = job_store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_generator():
        queue: asyncio.Queue = asyncio.Queue()
        _stream_queues[job_id] = queue
        try:
            while True:
                event: SSEEvent = await queue.get()
                yield f"event: {event.event}\ndata: {json.dumps(event.data)}\n\n"
                if event.event in ("done", "error"):
                    break
        finally:
            _stream_queues.pop(job_id, None)

    return StreamingResponse(event_generator(), media_type="text/event-stream")

@router.get("/{job_id}/events")
async def get_job_events(job_id: str):
    """
    返回该 job 的全部历史事件，供前端重连时回放。
    前端重连时先 GET /events 回放历史，再接 /stream 接收新事件。
    """
    job = job_store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    events = job_store.get_events(job_id)
    return {"events": [{"event": e.event, "data": e.data} for e in events]}

@router.post("/{job_id}/reply")
async def reply_to_job(job_id: str, req: ReplyRequest):
    """
    用户在介入节点（大纲确认）提交回复。
    调用 store.set_reply() 唤醒 Orchestrator 中挂起的 wait_for_reply() 协程。
    """
    job = job_store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    job_store.set_reply(job_id, req.message)
    return {"status": "ok"}

# 每个活跃 job 对应一个队列，push_event 写入，event_generator 消费
_stream_queues: dict[str, asyncio.Queue] = {}

async def push_event(job_id: str, event: SSEEvent):
    """Orchestrator 调用此函数向前端推送事件，同时写入历史日志"""
    job_store.append_event(job_id, event)
    queue = _stream_queues.get(job_id)
    if queue:
        await queue.put(event)

async def _run_agent(job_id: str):
    """
    后台任务：实例化 Orchestrator 并运行完整流水线。
    捕获所有异常，确保错误信息通过 SSE 传回前端而不是静默失败。
    """
    from backend.agent.orchestrator import Orchestrator
    job = job_store.get(job_id)
    if not job:
        return
    orch = Orchestrator(
        job_id=job_id,
        topic=job.topic,
        intervention_on_outline=job.intervention.on_outline,
    )
    try:
        await orch.run()
    except Exception as e:
        from backend.models import StageStatus
        job = job_store.get(job_id)
        if job:
            job.stage = StageStatus.ERROR
            job.error = str(e)
            job_store.update(job)
        await push_event(job_id, SSEEvent(event="error", data={"message": str(e)}))
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_jobs_router.py -v
```
Expected: 3 passed

- [ ] **Step 5: 运行全量测试确认无回归**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/ -v 2>&1 | tail -5
```
Expected: 32 passed

- [ ] **Step 6: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add backend/routers/jobs.py tests/test_jobs_router.py
git commit -m "feat: GET /events endpoint, push_event writes to log, fix intervention_on_chapter bug"
```

---

## Task 3: 前端 — useJobStream 重连回放

**Files:**
- Modify: `frontend/src/hooks/useJobStream.ts`

- [ ] **Step 1: 将 frontend/src/hooks/useJobStream.ts 完整替换为**

```typescript
import { useEffect, useRef } from 'react'
import type { SSEEventType } from '../types'

const API_BASE = 'http://localhost:8000'

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
 * 管理 SSE 长连接的自定义 Hook，支持断点续连。
 *
 * 重连流程：
 * 1. 先 GET /jobs/{id}/events 拉取历史事件并回放（幂等：重复事件不影响 UI）
 * 2. 再建立 SSE 长连接接收新事件
 *
 * @param jobId  - 要订阅的 Job ID；传 null 时不建立连接
 * @param onEvent - 收到事件时的回调，参数为 (事件类型, 解析后的 data 对象)
 */
export function useJobStream(
  jobId: string | null,
  onEvent: (type: SSEEventType, data: Record<string, unknown>) => void
) {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!jobId) return

    let es: EventSource | null = null
    let cancelled = false

    async function connect() {
      // Step 1: 回放历史事件
      try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/events`)
        if (!res.ok || cancelled) return
        const { events } = await res.json() as { events: Array<{ event: string; data: Record<string, unknown> }> }
        for (const e of events) {
          if (cancelled) return
          onEventRef.current(e.event as SSEEventType, e.data)
        }
      } catch {
        // 历史回放失败不阻断 SSE 连接
      }

      // Step 2: 建立 SSE 长连接接收新事件
      if (cancelled) return
      es = new EventSource(`${API_BASE}/jobs/${jobId}/stream`)

      SSE_EVENT_TYPES.forEach((type) => {
        es!.addEventListener(type, (e: MessageEvent) => {
          const data = JSON.parse(e.data)
          onEventRef.current(type, data)
        })
      })
    }

    connect()

    return () => {
      cancelled = true
      es?.close()
    }
  }, [jobId])
}
```

- [ ] **Step 2: 运行 TypeScript 类型检查**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer/frontend && npx tsc --noEmit 2>&1
```
Expected: 无错误

- [ ] **Step 3: 运行全量后端测试确认无回归**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/ -v 2>&1 | tail -5
```
Expected: 32 passed

- [ ] **Step 4: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add frontend/src/hooks/useJobStream.ts
git commit -m "feat: useJobStream fetches event history before SSE for reconnect replay"
```

---

## Self-Review Checklist

| Spec 要求 | Task |
|-----------|------|
| `JobStore._event_logs` 新增 | Task 1 |
| `append_event()` / `get_events()` | Task 1 |
| `push_event` 写入 event_log | Task 2 |
| `GET /jobs/{id}/events` 端点 | Task 2 |
| `intervention_on_chapter` bug 修复 | Task 2 |
| 前端重连先 fetch `/events` 回放 | Task 3 |
| `cancelled` flag 防止竞态 | Task 3 |
