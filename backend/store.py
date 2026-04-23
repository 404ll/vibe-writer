import asyncio
from typing import Optional
from backend.models import JobState, JobRequest

class JobStore:
    def __init__(self):
        self._jobs: dict[str, JobState] = {}
        self._reply_events: dict[str, asyncio.Event] = {}
        self._replies: dict[str, str] = {}

    def create_job(self, topic: str, intervention=None) -> JobState:
        from backend.models import InterventionConfig
        job = JobState(
            topic=topic,
            intervention=intervention or InterventionConfig(),
        )
        self._jobs[job.id] = job
        self._reply_events[job.id] = asyncio.Event()
        return job

    def get(self, job_id: str) -> Optional[JobState]:
        return self._jobs.get(job_id)

    def update(self, job: JobState):
        self._jobs[job.id] = job

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
            event.clear()
        return self._replies.get(job_id, "")

# Singleton for use in routers
job_store = JobStore()
