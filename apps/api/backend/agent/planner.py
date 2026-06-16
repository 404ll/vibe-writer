from backend.agent.base import BaseAgent
from backend.agent.prompts import OUTLINE_SYSTEM, OUTLINE_USER, outline_word_limit_instruction

class PlannerAgent(BaseAgent):
    """
    负责根据主题生成文章大纲。
    输入：topic (str), target_words (Optional[int])
    输出：chapters (list[str]) — 章节标题列表
    """

    async def plan(self, topic: str, target_words: int | None = None) -> list[str]:
        """调用 LLM 生成大纲，解析并返回章节标题列表"""
        raw = await self._call_llm(
            OUTLINE_SYSTEM,
            OUTLINE_USER.format(
                topic=topic,
                word_limit_instruction=outline_word_limit_instruction(target_words),
            ),
        )
        chapters = self._parse_outline(raw)
        return self._trim_outline_for_budget(chapters, target_words)

    def _trim_outline_for_budget(
        self, chapters: list[str], target_words: int | None
    ) -> list[str]:
        """字数紧张时截断章节数，避免 800 字拆成 7 章。"""
        if not target_words or not chapters:
            return chapters
        max_chapters = 3 if target_words <= 1000 else 4 if target_words <= 2000 else 5 if target_words <= 4000 else 6
        if len(chapters) > max_chapters:
            return chapters[:max_chapters]
        return chapters

    def _parse_outline(self, raw: str) -> list[str]:
        """解析编号列表，支持 '1. 标题' 和 '1、标题' 两种格式，忽略非编号行"""
        chapters = []
        for line in raw.strip().splitlines():
            line = line.strip()
            if not line:
                continue
            if not line[0].isdigit():
                continue
            dot_idx = line.find(".")
            space_idx = line.find("、")
            if dot_idx != -1:
                line = line[dot_idx + 1:].strip()
            elif space_idx != -1:
                line = line[space_idx + 1:].strip()
            if line:
                chapters.append(line)
        return chapters
