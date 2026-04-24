import os
import anthropic

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
