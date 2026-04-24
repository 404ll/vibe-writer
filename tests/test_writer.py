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
    # 验证当 research 为空时，prompt 包含"暂无参考资料"
    user_content = mock_client.messages.create.call_args.kwargs["messages"][0]["content"]
    assert "暂无参考资料" in user_content


@pytest.mark.asyncio
async def test_write_injects_review_feedback_into_prompt():
    """review_feedback 非空时，prompt 中应包含审稿意见"""
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="修改后的章节内容")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = WriterAgent()
        content = await agent.write(
            topic="AI Agents 入门",
            outline="1. 什么是 Agent",
            chapter_title="什么是 Agent",
            research="",
            review_feedback="内容过短，建议补充实际案例",
        )

    assert content == "修改后的章节内容"
    user_content = mock_client.messages.create.call_args.kwargs["messages"][0]["content"]
    assert "内容过短" in user_content
    assert "审稿意见" in user_content


@pytest.mark.asyncio
async def test_write_without_review_feedback_unchanged():
    """review_feedback 为空时，prompt 不包含审稿意见字样"""
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="正常章节内容")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = WriterAgent()
        await agent.write(
            topic="测试",
            outline="1. 章节一",
            chapter_title="章节一",
            research="",
            review_feedback="",
        )

    user_content = mock_client.messages.create.call_args.kwargs["messages"][0]["content"]
    assert "审稿意见" not in user_content
