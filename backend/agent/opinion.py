import logging
from backend.agent.base import BaseAgent
from backend.agent.prompts import OPINION_SYSTEM, OPINION_USER, OPINION_SEARCH_SYSTEM, OPINION_SEARCH_USER

log = logging.getLogger("vibe.opinion")


class OpinionAgent(BaseAgent):
    """
    为章节生成核心论点，并将论点转化为搜索词。

    流程：
    1. 根据 topic + outline + chapter_title 生成 2-3 个独立论点
    2. 将论点转化为搜索关键词（供 SearchAgent 使用）
    """

    async def generate(self, topic: str, outline: str, chapter_title: str) -> tuple[str, list[str]]:
        """
        返回 (opinions_text, search_queries)
        - opinions_text: 原始论点字符串，用于展示和传给 Writer
        - search_queries: 搜索词列表，传给 SearchAgent
        """
        opinions_text = await self._call_llm(
            OPINION_SYSTEM,
            OPINION_USER.format(topic=topic, outline=outline, chapter_title=chapter_title),
            max_tokens=300,
        )
        log.info("opinions generated  chapter=%r  opinions=%r", chapter_title, opinions_text[:100])

        search_text = await self._call_llm(
            OPINION_SEARCH_SYSTEM,
            OPINION_SEARCH_USER.format(opinions=opinions_text),
            max_tokens=200,
        )
        search_queries = [
            line.lstrip("- ").strip()
            for line in search_text.splitlines()
            if line.strip().startswith("-")
        ]
        log.info("search queries  chapter=%r  queries=%s", chapter_title, search_queries)

        return opinions_text, search_queries
