import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from backend.agent.writer import WriterAgent

@pytest.mark.asyncio
async def test_write_returns_content_string():
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="这是章节正文内容")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = WriterAgent()
        content = await agent.write(
            topic="AI Agents 入门",
            outline="1. 什么是 Agent\n2. 核心组件",
            chapter_title="什么是 Agent",
            research="- Agent 能自主执行任务",
        )

    assert content == "这是章节正文内容"
    # 验证 research 被注入进了 prompt
    call_args = mock_client.messages.create.call_args
    user_content = call_args.kwargs["messages"][0]["content"]
    assert "Agent 能自主执行任务" in user_content

@pytest.mark.asyncio
async def test_write_works_without_research():
    """research 为空字符串时正常写作"""
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="没有参考资料也能写")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = WriterAgent()
        content = await agent.write(
            topic="测试主题",
            outline="1. 章节一",
            chapter_title="章节一",
            research="",
        )

    assert content == "没有参考资料也能写"
