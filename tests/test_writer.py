import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from backend.agent.writer import WriterAgent

def _make_mock_client(text: str):
    """构造一个模拟 stop_reason=end_turn 的 LLM 响应，兼容 _call_llm_with_tools。"""
    mock_client = MagicMock()
    mock_block = MagicMock()
    mock_block.type = "text"
    mock_block.text = text
    mock_message = MagicMock()
    mock_message.stop_reason = "end_turn"
    mock_message.content = [mock_block]
    mock_client.messages.create = AsyncMock(return_value=mock_message)
    return mock_client


@pytest.mark.asyncio
async def test_write_returns_content_string():
    mock_client = _make_mock_client("这是章节正文内容")

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = WriterAgent()
        content = await agent.write(
            topic="AI Agents 入门",
            outline="1. 什么是 Agent\n2. 核心组件",
            chapter_title="什么是 Agent",
        )

    assert content == "这是章节正文内容"


@pytest.mark.asyncio
async def test_write_no_search_fn_uses_placeholder():
    """未注入 search_fn 时，prompt 包含'暂无参考资料'提示"""
    mock_client = _make_mock_client("没有搜索能力也能写")

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = WriterAgent()  # 不注入 search_fn
        await agent.write(
            topic="测试主题",
            outline="1. 章节一",
            chapter_title="章节一",
        )

    user_content = mock_client.messages.create.call_args.kwargs["messages"][0]["content"]
    assert "暂无参考资料" in user_content


@pytest.mark.asyncio
async def test_write_injects_review_feedback_into_prompt():
    """review_feedback 非空时，prompt 中应包含审稿意见"""
    mock_client = _make_mock_client("修改后的章节内容")

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = WriterAgent()
        content = await agent.write(
            topic="AI Agents 入门",
            outline="1. 什么是 Agent",
            chapter_title="什么是 Agent",
            review_feedback="内容过短，建议补充实际案例",
        )

    assert content == "修改后的章节内容"
    user_content = mock_client.messages.create.call_args.kwargs["messages"][0]["content"]
    assert "内容过短" in user_content
    assert "审稿意见" in user_content


@pytest.mark.asyncio
async def test_write_without_review_feedback_unchanged():
    """review_feedback 为空时，prompt 不包含审稿意见字样"""
    mock_client = _make_mock_client("正常章节内容")

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = WriterAgent()
        await agent.write(
            topic="测试",
            outline="1. 章节一",
            chapter_title="章节一",
            review_feedback="",
        )

    user_content = mock_client.messages.create.call_args.kwargs["messages"][0]["content"]
    assert "审稿意见" not in user_content


def test_style_instruction_injected_into_system_prompt():
    """预设风格'科普'时，_style_instruction 包含对应指令"""
    with patch("backend.agent.base.anthropic.AsyncAnthropic"):
        agent = WriterAgent(style="科普")
    assert "普通读者" in agent._style_instruction

def test_custom_style_used_as_instruction():
    """自定义风格原样作为指令"""
    with patch("backend.agent.base.anthropic.AsyncAnthropic"):
        agent = WriterAgent(style="幽默风趣，多用梗")
    assert agent._style_instruction == "幽默风趣，多用梗"
