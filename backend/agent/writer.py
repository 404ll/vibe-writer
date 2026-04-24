from typing import Optional
from backend.agent.base import BaseAgent
from backend.agent.prompts import CHAPTER_SYSTEM, CHAPTER_USER

STYLE_PROMPTS = {
    "技术博客": "写作风格：面向有经验的开发者，逻辑严密，代码示例充足，避免废话。",
    "科普":     "写作风格：面向普通读者，多用类比和生活化比喻，避免术语堆砌。",
    "教程":     "写作风格：手把手教学，步骤清晰，每步有预期结果，适合初学者跟随操作。",
}

class WriterAgent(BaseAgent):
    """
    负责根据章节标题、大纲和参考资料撰写章节正文。
    输入：topic, outline, chapter_title, research, style（可选）
    输出：章节正文 Markdown 字符串
    """

    def __init__(self, style: str = ""):
        super().__init__()
        # 预设风格取对应指令；自定义风格原样使用；空字符串不注入
        self._style_instruction = STYLE_PROMPTS.get(style, style)

    def _build_prompt(
        self,
        topic: str,
        outline: str,
        chapter_title: str,
        research: str,
        opinions: str,
        review_feedback: str = "",
        chapter_words: Optional[int] = None,
    ) -> tuple[str, str]:
        system = CHAPTER_SYSTEM
        if chapter_words:
            system += f"\n\n篇幅要求：本章目标约 {chapter_words} 字，请严格控制篇幅，不要超出太多。"
        if self._style_instruction:
            system += f"\n\n{self._style_instruction}"

        research_text = research if research.strip() else "暂无参考资料"
        opinions_text = opinions if opinions.strip() else "（无预设论点，自行判断）"
        user_prompt = CHAPTER_USER.format(
            topic=topic,
            outline=outline,
            chapter_title=chapter_title,
            opinions=opinions_text,
            research=research_text,
        )
        if review_feedback.strip():
            user_prompt += f"\n\n审稿意见：{review_feedback}\n请根据以上意见修改章节内容。"
        return system, user_prompt

    async def write(
        self,
        topic: str,
        outline: str,
        chapter_title: str,
        research: str,
        opinions: str = "",
        review_feedback: str = "",
        chapter_words: Optional[int] = None,
    ) -> str:
        system, user_prompt = self._build_prompt(
            topic, outline, chapter_title, research, opinions, review_feedback, chapter_words
        )
        return await self._call_llm(system, user_prompt)

    async def write_stream(
        self,
        topic: str,
        outline: str,
        chapter_title: str,
        research: str,
        opinions: str = "",
        review_feedback: str = "",
        chapter_words: Optional[int] = None,
    ):
        """流式写章节，异步 yield token，调用方负责拼接完整内容"""
        system, user_prompt = self._build_prompt(
            topic, outline, chapter_title, research, opinions, review_feedback, chapter_words
        )
        async for token in self._stream_llm(system, user_prompt):
            yield token
