import os
import json
import logging
import anthropic

log = logging.getLogger("vibe.base")

class BaseAgent:
    """
    所有 Agent 的基类，统一初始化 LLM 客户端。
    子类通过 self._client 和 self._call_llm() 调用 LLM。
    """

    def __init__(self):
        self._client = anthropic.AsyncAnthropic(
            api_key=os.environ.get("ANTHROPIC_API_KEY", "placeholder"),
            base_url=os.environ.get("ANTHROPIC_BASE_URL"),
        )

    async def _call_llm(self, system: str, user: str, max_tokens: int = 2048) -> str:
        """封装单次 LLM 调用，返回纯文本响应"""
        message = await self._client.messages.create(
            model=os.environ.get("MODEL_ID", "kimi-k2.5"),
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return message.content[0].text

    async def _call_llm_json(self, system: str, user: str, max_tokens: int = 512) -> dict:
        """调用 LLM 并解析 JSON 响应。解析失败时返回空 dict 并 log warning。"""
        raw = await self._call_llm(system, user, max_tokens)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            log.warning("JSON parse failed, raw=%r", raw[:200])
            return {}

    async def _stream_llm(self, system: str, user: str, max_tokens: int = 2048):
        """流式 LLM 调用，异步 yield 每个文本 token"""
        async with await self._client.messages.create(
            model=os.environ.get("MODEL_ID", "kimi-k2.5"),
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            stream=True,
        ) as stream:
            async for event in stream:
                if (
                    event.type == "content_block_delta"
                    and hasattr(event.delta, "text")
                ):
                    yield event.delta.text
