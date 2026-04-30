import pytest
import asyncio
from fastapi.testclient import TestClient
from unittest.mock import patch
from backend.main import app
from backend.store import JobStore
from backend.models import SSEEvent

client = TestClient(app)

def test_create_job_returns_job_id():
    response = client.post("/jobs", json={"topic": "AI Agents 入门"})
    assert response.status_code == 200
    data = response.json()
    assert "job_id" in data
    assert isinstance(data["job_id"], str)

def test_reply_to_unknown_job_returns_404():
    response = client.post("/jobs/nonexistent/reply", json={"message": "ok"})
    assert response.status_code == 404

def test_stream_unknown_job_returns_404():
    response = client.get("/jobs/nonexistent/stream")
    assert response.status_code == 404

def test_get_events_endpoint_returns_valid_format():
    """GET /events 端点返回有效格式（即使列表可能非空）"""
    res = client.post("/jobs", json={"topic": "测试主题", "intervention": {"on_outline": False}})
    job_id = res.json()["job_id"]
    events_res = client.get(f"/jobs/{job_id}/events")
    assert events_res.status_code == 200
    data = events_res.json()
    assert "events" in data
    assert isinstance(data["events"], list)
    # 每个事件应该有 event 和 data 字段
    for evt in data["events"]:
        assert "event" in evt
        assert "data" in evt

def test_get_events_returns_404_for_unknown_job():
    res = client.get("/jobs/nonexistent-id/events")
    assert res.status_code == 404

def test_push_event_writes_to_event_log():
    """push_event 调用后，event_log 中有对应记录"""
    import uuid
    from backend.routers.jobs import push_event
    from backend.store import job_store

    store = JobStore()
    job_id = str(uuid.uuid4())
    store.create_job(job_id=job_id, topic="测试主题")

    with patch("backend.routers.jobs.job_store", store):
        event = SSEEvent(event="stage_update", data={"stage": "plan"})
        asyncio.get_event_loop().run_until_complete(push_event(job_id, event))

    events = store.get_events(job_id)
    assert len(events) == 1
    assert events[0].event == "stage_update"
