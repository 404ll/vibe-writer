import logging
from backend.agent.base import BaseAgent
from backend.agent.prompts import OPINION_SYSTEM, OPINION_USER

log = logging.getLogger("vibe.opinion")


class OpinionAgent(BaseAgent):
    """
    为章节生成核心论点，并将论点转化为搜索词。

    流程：
    1. 一次 LLM 调用，同时输出论点列表和搜索词列表（JSON 格式）
    2. 解析失败时 fallback 返回空值，不中断写作流程
    """

    async def generate(self, topic: str, outline: str, chapter_title: str) -> tuple[str, list[str]]:
        """
        返回 (opinions_text, search_queries)
        - opinions_text: 论点字符串（"- 论点1\n- 论点2"），用于展示和传给 Writer
        - search_queries: 搜索词列表，传给 SearchAgent
        """
        data = await self._call_llm_json(
            OPINION_SYSTEM,
            OPINION_USER.format(topic=topic, outline=outline, chapter_title=chapter_title),
            max_tokens=400,
        )
        if not data or "opinions" not in data:
            log.warning("opinion generate: JSON parse failed  chapter=%r", chapter_title)
            return "", []

        opinions_list = data.get("opinions", [])
        search_queries = data.get("search_queries", [])
        opinions_text = "\n".join(f"- {o}" for o in opinions_list)

        log.info("opinions generated  chapter=%r  opinions=%r", chapter_title, opinions_text[:100])
        log.info("search queries  chapter=%r  queries=%s", chapter_title, search_queries)

        return opinions_text, search_queries
