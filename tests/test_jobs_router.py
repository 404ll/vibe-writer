import pytest
from fastapi.testclient import TestClient
from backend.main import app

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
