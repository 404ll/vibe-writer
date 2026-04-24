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
