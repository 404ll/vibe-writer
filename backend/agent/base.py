import os
import json
import logging
from typing import Callable, Awaitable
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

    async def _call_llm_with_tools(
        self,
        system: str,
        user: str,
        tools: list[dict],
        tool_handlers: dict[str, Callable[..., Awaitable[str]]],
        max_tokens: int = 4096,
        max_tool_rounds: int = 10,
    ) -> str:
        """
        Agent loop：持续调用 LLM 直到 stop_reason != "tool_use"。

        Pattern 来自 s01/s02：
            while stop_reason == "tool_use":
                response = LLM(messages, tools)
                execute tools → append tool_results
            return final text

        Args:
            tools: Anthropic 格式的工具定义列表
            tool_handlers: {tool_name: async fn(**input) -> str} dispatch map
            max_tool_rounds: 防止无限循环的安全上限
        """
        messages = [{"role": "user", "content": user}]

        for _ in range(max_tool_rounds):
            response = await self._client.messages.create(
                model=os.environ.get("MODEL_ID", "kimi-k2.5"),
                max_tokens=max_tokens,
                system=system,
                messages=messages,
                tools=tools,
            )
            messages.append({"role": "assistant", "content": response.content})

            if response.stop_reason != "tool_use":
                # LLM 决定停止，提取最终文本
                for block in response.content:
                    if hasattr(block, "text"):
                        return block.text
                return ""

            # 执行所有 tool_use 调用，收集结果
            tool_results = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                handler = tool_handlers.get(block.name)
                if handler:
                    try:
                        output = await handler(**block.input)
                    except Exception as e:
                        output = f"Error: {e}"
                else:
                    output = f"Unknown tool: {block.name}"
                log.info("tool_use  name=%r  output_len=%d", block.name, len(output))
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": output,
                })
            messages.append({"role": "user", "content": tool_results})

        log.warning("_call_llm_with_tools reached max_tool_rounds=%d", max_tool_rounds)
        return ""

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
