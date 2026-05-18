import os
import json
import logging
from typing import Callable, Awaitable
import anthropic

log = logging.getLogger("vibe.base")


def _model_id() -> str:
    return os.environ.get("MODEL_ID", "deepseek-v4-flash")


def _extract_text_from_content(content) -> str:
    """从 messages.content 提取文本；兼容 DeepSeek 的 thinking + text 多块响应。"""
    text_parts: list[str] = []
    thinking_parts: list[str] = []
    for block in content:
        block_type = getattr(block, "type", None)
        if block_type == "text" and getattr(block, "text", None):
            text_parts.append(block.text)
        elif block_type == "thinking" and getattr(block, "thinking", None):
            thinking_parts.append(block.thinking)
    if text_parts:
        return "".join(text_parts)
    if thinking_parts:
        log.warning(
            "no text blocks in response, falling back to thinking (%d blocks)",
            len(thinking_parts),
        )
        return "".join(thinking_parts)
    return ""


def _parse_json_from_text(raw: str) -> dict:
    """解析 LLM 返回的 JSON；容忍 markdown 包裹或前后多余文字。"""
    raw = raw.strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    if raw.startswith("```"):
        lines = raw.splitlines()
        inner = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
        try:
            return json.loads(inner.strip())
        except json.JSONDecodeError:
            pass
    start, end = raw.find("{"), raw.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(raw[start : end + 1])
        except json.JSONDecodeError:
            pass
    return {}


class BaseAgent:
    """
    所有 Agent 的基类，统一初始化 LLM 客户端。
    子类通过 self._client 和 self._call_llm() 调用 LLM。
    """

    def __init__(self):
        api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY is not set. Add it to .env (plain value, no ${...} wrapper)."
            )
        self._client = anthropic.AsyncAnthropic(
            api_key=api_key,
            base_url=os.environ.get("ANTHROPIC_BASE_URL"),
        )

    async def _call_llm(self, system: str, user: str, max_tokens: int = 2048) -> str:
        """封装单次 LLM 调用，返回纯文本响应"""
        tokens = max_tokens
        last_message = None
        for attempt in range(2):
            last_message = await self._client.messages.create(
                model=_model_id(),
                max_tokens=tokens,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
            text = _extract_text_from_content(last_message.content)
            if text:
                return text
            if attempt == 0 and last_message.stop_reason == "max_tokens":
                tokens = min(tokens * 2, 8192)
                log.warning("LLM hit max_tokens=%d, retrying with %d", max_tokens, tokens)
                continue
            break
        block_types = [getattr(b, "type", type(b).__name__) for b in (last_message.content if last_message else [])]
        raise RuntimeError(
            f"LLM returned empty content (stop_reason={getattr(last_message, 'stop_reason', None)!r}, blocks={block_types})"
        )

    async def _call_llm_json(self, system: str, user: str, max_tokens: int = 512) -> dict:
        """调用 LLM 并解析 JSON 响应。解析失败时返回空 dict 并 log warning。"""
        raw = await self._call_llm(system, user, max_tokens)
        data = _parse_json_from_text(raw)
        if not data:
            log.warning("JSON parse failed, raw=%r", raw[:200])
        return data

    # 工具调用模式：LLM 可以通过特殊格式请求调用工具，系统执行后将结果返回给 LLM，LLM 再决定下一步动作。
    async def _call_llm_with_tools(
        self,
        system: str,
        user: str,
        tools: list[dict],
        tool_handlers: dict[str, Callable[..., Awaitable[str]]],
        max_tokens: int = 4096,
        max_tool_rounds: int = 8,
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
                model=_model_id(),
                max_tokens=max_tokens,
                system=system,
                messages=messages,
                tools=tools,
            )
            messages.append({"role": "assistant", "content": response.content})

            if response.stop_reason != "tool_use":
                text = _extract_text_from_content(response.content)
                if not text:
                    log.warning(
                        "tool loop ended with empty text  stop_reason=%r",
                        response.stop_reason,
                    )
                return text

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
            model=_model_id(),
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
