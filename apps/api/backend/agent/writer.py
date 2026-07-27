import asyncio
from contextlib import suppress
from typing import AsyncIterable, AsyncIterator, Optional, Callable, Awaitable
from backend.agent.base import BaseAgent
from backend.agent.prompts import (
    CHAPTER_SYSTEM,
    CHAPTER_USER,
    chapter_word_limit_line,
    article_word_limit_line,
)

STYLE_PROMPTS = {
    "技术博客": "写作风格：面向有经验的开发者，逻辑严密，代码示例充足，避免废话。",
    "科普":     "写作风格：面向普通读者，多用类比和生活化比喻，避免术语堆砌。",
    "教程":     "写作风格：手把手教学，步骤清晰，每步有预期结果，适合初学者跟随操作。",
}

DIAGRAM_TOOL = {
    "name": "generate_diagram",
    "description": (
        "为当前章节生成一张 Mermaid 图表。"
        "当章节涉及流程、架构、状态机、时序等结构性内容时调用。"
        "纯概念性或叙述性章节不需要配图。"
    ),
    "input_schema": {
        "type": "object",
        "required": ["diagram_type", "mermaid_code"],
        "properties": {
            "diagram_type": {
                "type": "string",
                "enum": ["flowchart", "sequenceDiagram", "stateDiagram", "graph"],
                "description": "图表类型",
            },
            "mermaid_code": {
                "type": "string",
                "description": "完整的 Mermaid 代码，不含 ```mermaid 包裹",
            },
        },
    },
}

SEARCH_TOOL = {
    "name": "search",
    "description": (
        "搜索与当前章节相关的资料。需要具体数据、案例或技术细节时调用。"
        "涉及新闻、政策、市场数据时，搜索词宜带年份或「最新」。"
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "搜索词，5-15 字，聚焦可验证的事实与数据",
            }
        },
        "required": ["query"],
    },
}

WRITER_TOOLS = [SEARCH_TOOL, DIAGRAM_TOOL]

STREAM_BATCH_MIN_CHARS = 24
STREAM_BATCH_MAX_DELAY_SECONDS = 0.05

TOOL_PREPARATION_INSTRUCTION = """
当前是正式写作前的工具准备阶段，不要输出最终章节正文。
- 根据章节需要调用 search 或 generate_diagram；不需要时可以不调用。
- 工具调用结束后，只整理一份供下一阶段写作使用的简洁材料。
- 搜索结果保留关键事实和出处信息；Mermaid 代码必须原样保留。
""".strip()


async def _batch_text_deltas(
    deltas: AsyncIterable[str],
    min_chars: int = STREAM_BATCH_MIN_CHARS,
    max_delay_seconds: float = STREAM_BATCH_MAX_DELAY_SECONDS,
) -> AsyncIterator[str]:
    """合并过小的模型增量，兼顾流式观感和 SSE/React 更新成本。"""
    parts: list[str] = []
    chars = 0
    loop = asyncio.get_running_loop()
    last_flush = loop.time()
    iterator = deltas.__aiter__()
    next_delta = asyncio.create_task(iterator.__anext__())

    try:
        while True:
            timeout = None
            if parts:
                elapsed = loop.time() - last_flush
                timeout = max(0.0, max_delay_seconds - elapsed)

            done, _ = await asyncio.wait({next_delta}, timeout=timeout)
            if not done:
                yield "".join(parts)
                parts = []
                chars = 0
                last_flush = loop.time()
                continue

            try:
                delta = next_delta.result()
            except StopAsyncIteration:
                break
            next_delta = asyncio.create_task(iterator.__anext__())

            if not delta:
                continue
            parts.append(delta)
            chars += len(delta)
            now = loop.time()
            if chars >= min_chars or now - last_flush >= max_delay_seconds:
                yield "".join(parts)
                parts = []
                chars = 0
                last_flush = now
    finally:
        if not next_delta.done():
            next_delta.cancel()
        with suppress(asyncio.CancelledError, StopAsyncIteration):
            await next_delta
        aclose = getattr(iterator, "aclose", None)
        if aclose:
            with suppress(asyncio.CancelledError):
                await aclose()

    if parts:
        yield "".join(parts)


class WriterAgent(BaseAgent):
    """根据章节要点撰写正文；支持 search / diagram 工具。"""

    def __init__(
        self,
        style: str = "",
        search_fn: Optional[Callable[[str], Awaitable[str]]] = None,
    ):
        super().__init__()
        self._style_instruction = STYLE_PROMPTS.get(style, style)
        self._search_fn = search_fn

    def _build_prompt(
        self,
        topic: str,
        outline: str,
        chapter_title: str,
        opinions: str,
        search_hints: list[str] = None,
        review_feedback: str = "",
        chapter_words: Optional[int] = None,
        target_words: Optional[int] = None,
        research_context: Optional[str] = None,
        enable_tools: bool = True,
    ) -> tuple[str, str]:
        system = CHAPTER_SYSTEM
        limit_line = chapter_word_limit_line(chapter_words)
        if limit_line:
            system += f"\n\n{limit_line}"
        article_line = article_word_limit_line(target_words)
        if article_line:
            system += f"\n{article_line}"
        if self._style_instruction:
            system += f"\n\n{self._style_instruction}"
        if self._search_fn and enable_tools:
            system += "\n\n你可以调用 search 工具获取资料，搜索次数不超过 3 次。"

        opinions_text = opinions if opinions.strip() else "（按章节标题自行组织客观内容）"
        hints_text = ""
        if search_hints and enable_tools:
            hints_text = "\n\n搜索方向建议（可参考）：\n" + "\n".join(f"- {q}" for q in search_hints)

        if research_context is not None:
            research = research_context or "暂无参考资料"
        elif self._search_fn and enable_tools:
            research = "（请通过 search 工具自行获取所需资料）"
        else:
            research = "暂无参考资料"

        user_prompt = CHAPTER_USER.format(
            topic=topic,
            word_budget_line=article_line or "全文字数：不限制。",
            outline=outline,
            chapter_title=chapter_title,
            opinions=opinions_text,
            research=research,
        ) + hints_text
        if review_feedback.strip():
            user_prompt += f"\n\n审稿意见：{review_feedback}\n请根据以上意见修改章节内容。"
        return system, user_prompt

    def _max_tokens_for_chapter(self, chapter_words: Optional[int]) -> int:
        if not chapter_words:
            return 4096
        # 中文约 1.5–2 字/token，留少量余量给工具往返
        return min(8192, max(512, int(chapter_words * 2.2)))

    async def _handle_diagram(self, diagram_type: str, mermaid_code: str) -> str:
        return f"```mermaid\n{mermaid_code}\n```\n\n（图表已生成，请将以上代码块插入章节正文的合适位置）"

    async def write(
        self,
        topic: str,
        outline: str,
        chapter_title: str,
        opinions: str = "",
        search_hints: list[str] = None,
        review_feedback: str = "",
        chapter_words: Optional[int] = None,
        target_words: Optional[int] = None,
    ) -> str:
        system, user_prompt = self._build_prompt(
            topic, outline, chapter_title, opinions, search_hints,
            review_feedback, chapter_words, target_words,
        )
        tools = [DIAGRAM_TOOL]
        handlers = {"generate_diagram": self._handle_diagram}
        if self._search_fn:
            tools = [SEARCH_TOOL, DIAGRAM_TOOL]
            handlers["search"] = lambda query: self._search_fn(query)
        return await self._call_llm_with_tools(
            system=system,
            user=user_prompt,
            tools=tools,
            tool_handlers=handlers,
            max_tokens=self._max_tokens_for_chapter(chapter_words),
        )

    async def write_stream(
        self,
        topic: str,
        outline: str,
        chapter_title: str,
        opinions: str = "",
        search_hints: list[str] = None,
        review_feedback: str = "",
        chapter_words: Optional[int] = None,
        target_words: Optional[int] = None,
    ):
        preparation_system, preparation_prompt = self._build_prompt(
            topic, outline, chapter_title, opinions, search_hints,
            review_feedback, chapter_words, target_words,
        )
        tools = [DIAGRAM_TOOL]
        handlers = {"generate_diagram": self._handle_diagram}
        if self._search_fn:
            tools = [SEARCH_TOOL, DIAGRAM_TOOL]
            handlers["search"] = lambda query: self._search_fn(query)
        prepared_context = await self._call_llm_with_tools(
            system=f"{preparation_system}\n\n{TOOL_PREPARATION_INSTRUCTION}",
            user=preparation_prompt,
            tools=tools,
            tool_handlers=handlers,
            max_tokens=min(2048, self._max_tokens_for_chapter(chapter_words)),
        )

        final_system, final_prompt = self._build_prompt(
            topic, outline, chapter_title, opinions, search_hints,
            review_feedback, chapter_words, target_words,
            research_context=prepared_context.strip() or "（工具准备阶段没有补充材料）",
            enable_tools=False,
        )
        final_prompt += "\n\n现在直接输出完整章节正文，不要描述工具调用或写作过程。"

        deltas = self._stream_llm(
            system=final_system,
            user=final_prompt,
            max_tokens=self._max_tokens_for_chapter(chapter_words),
        )
        async for chunk in _batch_text_deltas(deltas):
            yield chunk
