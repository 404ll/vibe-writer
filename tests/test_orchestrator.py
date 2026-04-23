import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from backend.agent.orchestrator import Orchestrator

@pytest.mark.asyncio
async def test_parse_outline_extracts_chapters():
    orch = Orchestrator.__new__(Orchestrator)
    raw = "1. 什么是 Agent\n2. Agent 的核心组件\n3. 实战案例"
    chapters = orch._parse_outline(raw)
    assert chapters == ["什么是 Agent", "Agent 的核心组件", "实战案例"]

@pytest.mark.asyncio
async def test_run_emits_outline_ready_event(monkeypatch):
    events = []

    async def fake_push(job_id, event):
        events.append(event)

    monkeypatch.setattr("backend.agent.orchestrator.push_event", fake_push)

    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="1. 什么是 Agent\n2. 核心组件")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.orchestrator.anthropic.AsyncAnthropic", return_value=mock_client):
        orch = Orchestrator("job-123", "AI Agents 入门", intervention_on_outline=False)
        await orch.run()

    event_types = [e.event for e in events]
    assert "outline_ready" in event_types
    assert "done" in event_types
