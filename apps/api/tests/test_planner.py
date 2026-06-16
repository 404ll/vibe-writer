import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from backend.agent.planner import PlannerAgent


# ---------------------------------------------------------------------------
# Direct unit tests for _parse_outline (pure function, no LLM needed)
# ---------------------------------------------------------------------------

def make_agent() -> PlannerAgent:
    """构造一个不需要真实 API key 的 PlannerAgent 实例"""
    with patch("backend.agent.base.anthropic.AsyncAnthropic"):
        return PlannerAgent()


def test_parse_outline_normal_numbered_list():
    """标准编号列表能被正确解析"""
    agent = make_agent()
    raw = "1. 章节一\n2. 章节二\n3. 章节三"
    assert agent._parse_outline(raw) == ["章节一", "章节二", "章节三"]


def test_parse_outline_filters_noise_lines():
    """LLM 输出的前缀/后缀噪音行应被忽略"""
    agent = make_agent()
    raw = "以下是大纲：\n1. 章节一\n2. 章节二\n以上共两章。"
    assert agent._parse_outline(raw) == ["章节一", "章节二"]


def test_parse_outline_ignores_empty_lines_between_items():
    """编号项之间的空行应被跳过"""
    agent = make_agent()
    raw = "1. 章节一\n\n2. 章节二\n"
    assert agent._parse_outline(raw) == ["章节一", "章节二"]


def test_parse_outline_chinese_enum_separator():
    """支持 '1、标题' 格式（顿号分隔符）"""
    agent = make_agent()
    raw = "1、引言\n2、正文\n3、结论"
    assert agent._parse_outline(raw) == ["引言", "正文", "结论"]

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
