import asyncio
import json
import logging
import uuid
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from backend.models import JobRequest, ReplyRequest, SSEEvent, WriterState
from backend.store import job_store

log = logging.getLogger("vibe.jobs")
router = APIRouter(prefix="/jobs")


@router.post("")
async def create_job(req: JobRequest):
    """
    创建写作任务并立即返回 job_id。
    图以后台 Task 形式异步运行，不阻塞本次 HTTP 响应。
    """
    job_id = str(uuid.uuid4())
    job_store.create_job(
        job_id=job_id,
        topic=req.topic,
        style=req.style,
        target_words=req.target_words,
        intervention=req.intervention,
    )
    asyncio.create_task(_run_agent(job_id))
    return {"job_id": job_id}


@router.get("/{job_id}/stream")
async def stream_job(job_id: str):
    """
    SSE 长连接端点。
    前端通过 EventSource 订阅，graph 节点调用 push_event() 时实时推送。
    """
    if not job_store.exists(job_id):
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_generator():
        queue: asyncio.Queue = asyncio.Queue()
        _stream_queues[job_id] = queue
        try:
            while True:
                event: SSEEvent = await queue.get()
                yield f"event: {event.event}\ndata: {json.dumps(event.data)}\n\n"
                if event.event in ("done", "cancelled", "error"):
                    break
        finally:
            _stream_queues.pop(job_id, None)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.get("/{job_id}/events")
async def get_job_events(job_id: str):
    """返回该 job 的全部历史事件，供前端重连时回放。"""
    if not job_store.exists(job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    events = job_store.get_events(job_id)
    return {"events": [{"event": e.event, "data": e.data} for e in events]}


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: str):
    """请求取消正在运行的任务。"""
    if not job_store.exists(job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    job_store.cancel(job_id)
    return {"status": "ok"}


@router.post("/{job_id}/reply")
async def reply_to_job(job_id: str, req: ReplyRequest):
    """用户在介入节点提交回复，唤醒挂起的 wait_for_reply()。"""
    if not job_store.exists(job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    job_store.set_reply(job_id, req.message)
    return {"status": "ok"}


# ── 内部实现 ──────────────────────────────────────────────────

_stream_queues: dict[str, asyncio.Queue] = {}


async def push_event(job_id: str, event: SSEEvent):
    """graph 节点调用此函数向前端推送事件，同时写入历史日志"""
    job_store.append_event(job_id, event)
    queue = _stream_queues.get(job_id)
    if queue:
        await queue.put(event)


async def _run_agent(job_id: str):
    """
    后台任务：构建 LangGraph 图并运行。
    graph 的 import 放在函数内部避免循环依赖
    （graph.py 间接 import push_event，push_event 在本文件）。

    checkpointer 用 async with 管理生命周期，确保连接在 job 结束后关闭。
    """
    from backend.agent.graph import build_graph

    meta = job_store.get_meta(job_id)
    if not meta:
        return

    initial_state: WriterState = {
        "topic": meta["topic"],
        "style": meta["style"],
        "target_words": meta["target_words"],
        "outline": [],
        "chapters": [],
        "rewrite_count": 0,
        "error": None,
        "final_content": "",
    }

    try:
        intervention = meta.get("intervention")
        on_outline = intervention.on_outline if intervention else True
        graph = build_graph(
            job_id=job_id,
            style=meta["style"],
            target_words=meta["target_words"],
            push_event=push_event,
            wait_for_reply=job_store.wait_for_reply if on_outline else None,
            is_cancelled=job_store.is_cancelled,
        )
        await graph.ainvoke(
            initial_state,
            config={"configurable": {"thread_id": job_id}},
        )
    except asyncio.CancelledError:
        log.info("job cancelled  job_id=%s", job_id)
        await push_event(job_id, SSEEvent(event="cancelled", data={}))
    except Exception as e:
        log.error("graph failed  job_id=%s  err=%s", job_id, e)
        await push_event(job_id, SSEEvent(event="error", data={"message": str(e)}))
