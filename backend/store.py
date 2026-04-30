import asyncio
from typing import Optional
from backend.models import SSEEvent, InterventionConfig


class JobStore:
    """
    轻量化 Job 存储。
    业务状态已迁移到 LangGraph WriterState。
    本类只保留：
    - 元数据（topic/style/target_words）供 API 查询
    - SSE 事件队列（实时推送）
    - 用户 reply 机制（human-in-the-loop）
    - 事件历史日志（断线重连回放）
    - 取消标志
    """

    def __init__(self):
        self._meta: dict[str, dict] = {}
        self._reply_events: dict[str, asyncio.Event] = {}
        self._replies: dict[str, str] = {}
        self._event_logs: dict[str, list[SSEEvent]] = {}
        self._cancel_flags: dict[str, bool] = {}

    def create_job(self, job_id: str, topic: str, style: str = "",
                   target_words: Optional[int] = None,
                   intervention: Optional[InterventionConfig] = None):
        self._meta[job_id] = {
            "topic": topic,
            "style": style,
            "target_words": target_words,
            "intervention": intervention or InterventionConfig(),
        }
        self._reply_events[job_id] = asyncio.Event()
        self._event_logs[job_id] = []
        self._cancel_flags[job_id] = False

    def get_meta(self, job_id: str) -> Optional[dict]:
        return self._meta.get(job_id)

    def exists(self, job_id: str) -> bool:
        return job_id in self._meta

    def set_reply(self, job_id: str, message: str):
        self._replies[job_id] = message
        if job_id in self._reply_events:
            self._reply_events[job_id].set()

    def get_reply(self, job_id: str) -> Optional[str]:
        return self._replies.get(job_id)

    async def wait_for_reply(self, job_id: str) -> str:
        event = self._reply_events.get(job_id)
        if event:
            await event.wait()
        return self._replies.get(job_id, "")

    def append_event(self, job_id: str, event: SSEEvent):
        if job_id in self._event_logs:
            self._event_logs[job_id].append(event)

    def get_events(self, job_id: str) -> list[SSEEvent]:
        return self._event_logs.get(job_id, [])

    def cancel(self, job_id: str):
        self._cancel_flags[job_id] = True
        if job_id in self._reply_events:
            self._reply_events[job_id].set()

    def is_cancelled(self, job_id: str) -> bool:
        return self._cancel_flags.get(job_id, False)


job_store = JobStore()
