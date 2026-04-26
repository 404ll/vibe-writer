import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from backend.agent.opinion import OpinionAgent


@pytest.mark.asyncio
async def test_generate_returns_opinions_and_queries():
    """generate() 一次调用返回论点文本和搜索词列表"""
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text='''{
        "opinions": ["AI 会取代初级程序员", "工具链复杂度是真正门槛"],
        "search_queries": ["AI 取代程序员 2024", "编程工具链复杂度趋势"]
    }''')]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = OpinionAgent()
        opinions_text, search_queries = await agent.generate(
            topic="AI 与程序员",
            outline="1. 现状\n2. 影响",
            chapter_title="AI 会取代程序员吗",
        )

    assert "AI 会取代初级程序员" in opinions_text
    assert "工具链复杂度是真正门槛" in opinions_text
    assert search_queries == ["AI 取代程序员 2024", "编程工具链复杂度趋势"]
    # 只调用了一次 LLM
    assert mock_client.messages.create.call_count == 1


@pytest.mark.asyncio
async def test_generate_fallback_on_invalid_json():
    """JSON 解析失败时返回空论点和空搜索词，不抛异常"""
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="无法解析的输出")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = OpinionAgent()
        opinions_text, search_queries = await agent.generate(
            topic="测试",
            outline="1. 章节一",
            chapter_title="章节一",
        )

    assert opinions_text == ""
    assert search_queries == []
