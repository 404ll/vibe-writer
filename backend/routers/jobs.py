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
    job = job_store.create_job(req.topic, req.intervention, req.style)
    # asyncio.create_task 把 agent 扔进事件循环后台运行
    asyncio.create_task(_run_agent(job.id))
    return {"job_id": job.id}

@router.get("/{job_id}/stream")
async def stream_job(job_id: str):
    """
    SSE（Server-Sent Events）长连接端点。
    前端通过 EventSource 订阅，每当 Orchestrator 调用 push_event()，
    事件就会实时推送到浏览器，驱动进度条和 ReviewPanel 更新。

    协议格式：
        event: <事件类型>
        data: <JSON 字符串>

    事件类型：stage_update | outline_ready | chapter_done | done | error
    """
    job = job_store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_generator():
        # 为本次连接创建专属队列，push_event 往这里写，generator 从这里读
        queue: asyncio.Queue = asyncio.Queue()
        _stream_queues[job_id] = queue
        try:
            while True:
                event: SSEEvent = await queue.get()
                yield f"event: {event.event}\ndata: {json.dumps(event.data)}\n\n"
                # done / error 是终止信号，关闭流
                if event.event in ("done", "cancelled", "error"):
                    break
        finally:
            # 客户端断开连接时清理队列，防止内存泄漏
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

@router.post("/{job_id}/cancel")
async def cancel_job(job_id: str):
    """
    请求取消正在运行的任务。
    Orchestrator 在下一个阶段检查点检测到取消标志后，干净地退出并推送 cancelled 事件。
    """
    job = job_store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    job_store.cancel(job_id)
    return {"status": "ok"}

@router.post("/{job_id}/reply")
async def reply_to_job(job_id: str, req: ReplyRequest):
    """
    用户在介入节点（大纲确认 / 每章确认）提交回复。
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

    注意：Orchestrator 的 import 放在函数内部，是为了打破循环依赖：
    orchestrator.py 在模块级 import 了 push_event（来自本文件），
    如果本文件也在模块级 import Orchestrator，就会形成循环。
    """
    from backend.agent.orchestrator import Orchestrator
    job = job_store.get(job_id)
    if not job:
        return
    orch = Orchestrator(
        job_id=job_id,
        topic=job.topic,
        intervention_on_outline=job.intervention.on_outline,
        style=job.style,
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
