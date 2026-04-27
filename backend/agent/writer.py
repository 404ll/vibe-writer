from typing import Optional, Callable, Awaitable
from backend.agent.base import BaseAgent
from backend.agent.prompts import CHAPTER_SYSTEM, CHAPTER_USER

STYLE_PROMPTS = {
    "技术博客": "写作风格：面向有经验的开发者，逻辑严密，代码示例充足，避免废话。",
    "科普":     "写作风格：面向普通读者，多用类比和生活化比喻，避免术语堆砌。",
    "教程":     "写作风格：手把手教学，步骤清晰，每步有预期结果，适合初学者跟随操作。",
}

# 始终可用的工具
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

# search 工具（仅当 search_fn 注入时使用）
SEARCH_TOOL = {
    "name": "search",
    "description": "搜索与当前章节相关的资料。当你需要具体数据、案例或技术细节来支撑论点时调用。",
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "搜索词，5-15 字，聚焦于能找到支撑证据或数据的角度",
            }
        },
        "required": ["query"],
    },
}

# 向后兼容（WRITER_TOOLS 保留，包含两个工具）
WRITER_TOOLS = [SEARCH_TOOL, DIAGRAM_TOOL]


class WriterAgent(BaseAgent):
    """
    负责根据章节标题、大纲和核心论点撰写章节正文。

    从流水线 Agent 升级为自主 Agent：
    - 不再被动接收 research，而是在写作过程中主动调用 search 工具
    - 通过 _call_llm_with_tools 实现 ReAct loop
    - search_fn 由外部注入，保持 WriterAgent 与搜索实现解耦
    """

    def __init__(
        self,
        style: str = "",
        search_fn: Optional[Callable[[str], Awaitable[str]]] = None,
    ):
        super().__init__()
        self._style_instruction = STYLE_PROMPTS.get(style, style)
        # 注入的搜索函数：async (query: str) -> str
        # 为 None 时 Writer 仍可运行，只是没有搜索能力
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
    ) -> tuple[str, str]:
        system = CHAPTER_SYSTEM
        if chapter_words:
            system += f"\n\n篇幅要求：本章目标约 {chapter_words} 字，请严格控制篇幅，不要超出太多。"
        if self._style_instruction:
            system += f"\n\n{self._style_instruction}"
        if self._search_fn:
            system += "\n\n你可以调用 search 工具获取资料，在需要具体数据或案例时主动搜索，搜索次数不超过 3 次。"

        opinions_text = opinions if opinions.strip() else "（无预设论点，自行判断）"
        hints_text = ""
        if search_hints:
            hints_text = "\n\n搜索方向建议（可参考，也可自行判断）：\n" + "\n".join(f"- {q}" for q in search_hints)

        user_prompt = CHAPTER_USER.format(
            topic=topic,
            outline=outline,
            chapter_title=chapter_title,
            opinions=opinions_text,
            research="（请通过 search 工具自行获取所需资料）" if self._search_fn else "暂无参考资料",
        ) + hints_text
        if review_feedback.strip():
            user_prompt += f"\n\n审稿意见：{review_feedback}\n请根据以上意见修改章节内容。"
        return system, user_prompt

    async def _handle_diagram(self, diagram_type: str, mermaid_code: str) -> str:
        """将 LLM 生成的 Mermaid 代码包装成 fenced code block 返回给 LLM"""
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
    ) -> str:
        system, user_prompt = self._build_prompt(
            topic, outline, chapter_title, opinions, search_hints, review_feedback, chapter_words
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
    ):
        """流式写章节，异步 yield token，调用方负责拼接完整内容。
        注意：tool_use 阶段（搜索中）不产生 token，前端会有短暂停顿。
        """
        system, user_prompt = self._build_prompt(
            topic, outline, chapter_title, opinions, search_hints, review_feedback, chapter_words
        )
        tools = [DIAGRAM_TOOL]
        handlers = {"generate_diagram": self._handle_diagram}
        if self._search_fn:
            tools = [SEARCH_TOOL, DIAGRAM_TOOL]
            handlers["search"] = lambda query: self._search_fn(query)
        # tool_use 模式不支持真正的流式，先完整生成再 yield
        content = await self._call_llm_with_tools(
            system=system,
            user=user_prompt,
            tools=tools,
            tool_handlers=handlers,
        )
        yield content
