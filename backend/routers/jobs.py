import asyncio
import json
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from backend.models import JobRequest, ReplyRequest, SSEEvent
from backend.store import job_store

router = APIRouter(prefix="/jobs")

@router.post("")
async def create_job(req: JobRequest):
    job = job_store.create_job(req.topic, req.intervention)
    # Start agent in background
    asyncio.create_task(_run_agent(job.id))
    return {"job_id": job.id}

@router.get("/{job_id}/stream")
async def stream_job(job_id: str):
    job = job_store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_generator():
        queue = asyncio.Queue()
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

@router.post("/{job_id}/reply")
async def reply_to_job(job_id: str, req: ReplyRequest):
    job = job_store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    job_store.set_reply(job_id, req.message)
    return {"status": "ok"}

# Internal: per-job SSE queues
_stream_queues: dict[str, asyncio.Queue] = {}

async def push_event(job_id: str, event: SSEEvent):
    queue = _stream_queues.get(job_id)
    if queue:
        await queue.put(event)

async def _run_agent(job_id: str):
    """Placeholder — replaced by orchestrator in Task 4."""
    from backend.models import SSEEvent
    await asyncio.sleep(0.1)
    await push_event(job_id, SSEEvent(event="done", data={"message": "stub"}))
