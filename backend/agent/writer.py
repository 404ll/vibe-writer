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

    async def write(
        self,
        topic: str,
        outline: str,
        chapter_title: str,
        research: str,
        review_feedback: str = "",
    ) -> str:
        """
        调用 LLM 写章节正文。
        research 为空时 prompt 中显示"暂无参考资料"。
        review_feedback 非空时在 prompt 末尾追加审稿意见，用于重写场景。
        style 非空时在 system prompt 末尾追加风格指令。
        """
        system = CHAPTER_SYSTEM
        if self._style_instruction:
            system += f"\n\n{self._style_instruction}"

        research_text = research if research.strip() else "暂无参考资料"
        user_prompt = CHAPTER_USER.format(
            topic=topic,
            outline=outline,
            chapter_title=chapter_title,
            research=research_text,
        )
        if review_feedback.strip():
            user_prompt += f"\n\n审稿意见：{review_feedback}\n请根据以上意见修改章节内容。"
        return await self._call_llm(system, user_prompt)
