import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from backend.agent.planner import PlannerAgent

@pytest.mark.asyncio
async def test_plan_returns_chapter_list():
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="1. 什么是 Agent\n2. 核心组件\n3. 实战案例")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = PlannerAgent()
        chapters = await agent.plan("AI Agents 入门")

    assert chapters == ["什么是 Agent", "核心组件", "实战案例"]

@pytest.mark.asyncio
async def test_plan_handles_empty_lines():
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="1. 章节一\n\n2. 章节二\n")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = PlannerAgent()
        chapters = await agent.plan("测试主题")

    assert chapters == ["章节一", "章节二"]
