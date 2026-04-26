import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from backend.agent.base import BaseAgent


@pytest.mark.asyncio
async def test_call_llm_json_returns_parsed_dict():
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text='{"passed": true, "feedback": ""}')]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = BaseAgent()
        result = await agent._call_llm_json("system", "user")

    assert result == {"passed": True, "feedback": ""}


@pytest.mark.asyncio
async def test_call_llm_json_returns_empty_dict_on_invalid_json():
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="这不是JSON")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = BaseAgent()
        result = await agent._call_llm_json("system", "user")

    assert result == {}
