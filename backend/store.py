import asyncio
from typing import Optional
from backend.models import JobState, JobRequest, InterventionConfig

class JobStore:
    """
    内存中的 Job 状态存储。

    每个 Job 有三张表：
    - _jobs:         job_id → JobState，保存完整状态
    - _reply_events: job_id → asyncio.Event，用于阻塞等待用户回复
    - _replies:      job_id → str，保存用户最新回复内容

    设计模式：Singleton（模块底部的 job_store 实例）
    单进程单线程（asyncio），不需要加锁。
    """

    def __init__(self):
        self._jobs: dict[str, JobState] = {}
        self._reply_events: dict[str, asyncio.Event] = {}
        self._replies: dict[str, str] = {}

    def create_job(self, topic: str, intervention=None) -> JobState:
        """创建新 Job，分配 UUID，初始化对应的 asyncio.Event"""
        job = JobState(
            topic=topic,
            intervention=intervention or InterventionConfig(),
        )
        self._jobs[job.id] = job
        self._reply_events[job.id] = asyncio.Event()
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

# 全局单例，供 routers 和 orchestrator 共享同一份状态
job_store = JobStore()
