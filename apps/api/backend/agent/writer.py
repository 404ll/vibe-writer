from typing import Optional, Callable, Awaitable
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
        if self._search_fn:
            system += "\n\n你可以调用 search 工具获取资料，搜索次数不超过 3 次。"

        opinions_text = opinions if opinions.strip() else "（按章节标题自行组织客观内容）"
        hints_text = ""
        if search_hints:
            hints_text = "\n\n搜索方向建议（可参考）：\n" + "\n".join(f"- {q}" for q in search_hints)

        user_prompt = CHAPTER_USER.format(
            topic=topic,
            word_budget_line=article_line or "全文字数：不限制。",
            outline=outline,
            chapter_title=chapter_title,
            opinions=opinions_text,
            research="（请通过 search 工具自行获取所需资料）" if self._search_fn else "暂无参考资料",
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
        system, user_prompt = self._build_prompt(
            topic, outline, chapter_title, opinions, search_hints,
            review_feedback, chapter_words, target_words,
        )
        tools = [DIAGRAM_TOOL]
        handlers = {"generate_diagram": self._handle_diagram}
        if self._search_fn:
            tools = [SEARCH_TOOL, DIAGRAM_TOOL]
            handlers["search"] = lambda query: self._search_fn(query)
        content = await self._call_llm_with_tools(
            system=system,
            user=user_prompt,
            tools=tools,
            tool_handlers=handlers,
            max_tokens=self._max_tokens_for_chapter(chapter_words),
        )
        yield content
