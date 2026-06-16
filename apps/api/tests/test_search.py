import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from backend.agent.search import SearchAgent

@pytest.mark.asyncio
async def test_search_returns_research_string():
    mock_tavily = MagicMock()
    mock_tavily.search = MagicMock(return_value={
        "results": [
            {"content": "Agent 是能自主执行任务的 AI 系统"},
            {"content": "LangChain 是常用的 Agent 框架"},
        ]
    })

    mock_llm_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="- Agent 能自主执行任务\n- LangChain 是常用框架")]
    mock_llm_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.search.TavilyClient", return_value=mock_tavily), \
         patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_llm_client), \
         patch.dict("os.environ", {"TAVILY_API_KEY": "test-key"}):
        agent = SearchAgent()
        result = await agent.search(queries=["AI Agent 入门"], opinions="")

    assert "Agent" in result
    assert isinstance(result, str)

@pytest.mark.asyncio
async def test_search_returns_empty_string_on_failure():
    """搜索失败时降级返回空字符串，不抛异常"""
    mock_tavily = MagicMock()
    mock_tavily.search = MagicMock(side_effect=Exception("API error"))

    with patch("backend.agent.search.TavilyClient", return_value=mock_tavily):
        agent = SearchAgent()
        result = await agent.search(queries=["任意主题"], opinions="")

    assert result == ""

@pytest.mark.asyncio
async def test_search_returns_empty_string_when_no_results():
    """搜索无结果时返回空字符串"""
    mock_tavily = MagicMock()
    mock_tavily.search = MagicMock(return_value={"results": []})

    with patch("backend.agent.search.TavilyClient", return_value=mock_tavily):
        agent = SearchAgent()
        result = await agent.search(queries=["任意主题"], opinions="")

    assert result == ""
