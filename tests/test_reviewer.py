import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from backend.agent.reviewer import ReviewAgent, ReviewResult


@pytest.mark.asyncio
async def test_review_chapter_passed():
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="PASSED")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = ReviewAgent()
        result = await agent.review_chapter(
            chapter_title="什么是 Agent",
            content="Agent 是能自主执行任务的 AI 系统..." * 10,
            outline="1. 什么是 Agent\n2. 核心组件",
        )

    assert result.passed is True
    assert result.feedback == ""


@pytest.mark.asyncio
async def test_review_chapter_failed():
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="FAILED\n理由：内容过短\n建议：补充实际案例")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = ReviewAgent()
        result = await agent.review_chapter(
            chapter_title="核心组件",
            content="很短的内容",
            outline="1. 什么是 Agent\n2. 核心组件",
        )

    assert result.passed is False
    assert "内容过短" in result.feedback


@pytest.mark.asyncio
async def test_review_full_returns_per_chapter_results():
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="章节1: PASSED\n章节2: FAILED\n理由：逻辑跳跃\n建议：加过渡段")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = ReviewAgent()
        results = await agent.review_full(
            topic="AI Agents 入门",
            chapters=[
                {"title": "什么是 Agent", "content": "内容一"},
                {"title": "核心组件", "content": "内容二"},
            ],
        )

    assert len(results) == 2
    assert results[0].passed is True
    assert results[1].passed is False
    assert "逻辑跳跃" in results[1].feedback


@pytest.mark.asyncio
async def test_review_full_fallback_when_parse_fails():
    """LLM 输出格式异常时，所有章节默认 PASSED（不中断流程）"""
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="无法解析的输出")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = ReviewAgent()
        results = await agent.review_full(
            topic="测试",
            chapters=[{"title": "章节一", "content": "内容"}],
        )

    assert len(results) == 1
    assert results[0].passed is True
