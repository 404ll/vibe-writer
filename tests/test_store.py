import asyncio
import pytest
from backend.store import JobStore
from backend.models import JobState, StageStatus

def test_create_job():
    store = JobStore()
    job = store.create_job("AI Agents 入门")
    assert job.id is not None
    assert job.topic == "AI Agents 入门"
    assert job.stage == StageStatus.PLAN

def test_get_job_returns_none_for_unknown():
    store = JobStore()
    assert store.get("nonexistent-id") is None

def test_set_reply_unblocks_wait():
    store = JobStore()
    job = store.create_job("test topic")
    store.set_reply(job.id, "user reply text")
    assert store.get_reply(job.id) == "user reply text"
