from backend.agent.base import BaseAgent
from backend.agent.prompts import OUTLINE_SYSTEM, OUTLINE_USER

class PlannerAgent(BaseAgent):
    """
    负责根据主题生成文章大纲。
    输入：topic (str)
    输出：chapters (list[str]) — 章节标题列表
    """

    async def plan(self, topic: str) -> list[str]:
        """调用 LLM 生成大纲，解析并返回章节标题列表"""
        raw = await self._call_llm(
            OUTLINE_SYSTEM,
            OUTLINE_USER.format(topic=topic),
        )
        return self._parse_outline(raw)

    def _parse_outline(self, raw: str) -> list[str]:
        """解析编号列表，支持 '1. 标题' 和 '1、标题' 两种格式"""
        chapters = []
        for line in raw.strip().splitlines():
            line = line.strip()
            if not line:
                continue
            if line[0].isdigit():
                dot_idx = line.find(".")
                space_idx = line.find("、")
                if dot_idx != -1:
                    line = line[dot_idx + 1:].strip()
                elif space_idx != -1:
                    line = line[space_idx + 1:].strip()
            if line:
                chapters.append(line)
        return chapters
