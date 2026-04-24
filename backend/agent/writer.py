from backend.agent.base import BaseAgent
from backend.agent.prompts import CHAPTER_SYSTEM, CHAPTER_USER

class WriterAgent(BaseAgent):
    """
    负责根据章节标题、大纲和参考资料撰写章节正文。
    输入：topic, outline, chapter_title, research
    输出：章节正文 Markdown 字符串
    """

    async def write(
        self,
        topic: str,
        outline: str,
        chapter_title: str,
        research: str,
    ) -> str:
        """
        调用 LLM 写章节正文。
        research 为空时 prompt 中显示"暂无参考资料"，LLM 依靠自身知识写作。
        """
        research_text = research if research.strip() else "暂无参考资料"
        return await self._call_llm(
            CHAPTER_SYSTEM,
            CHAPTER_USER.format(
                topic=topic,
                outline=outline,
                chapter_title=chapter_title,
                research=research_text,
            ),
        )
