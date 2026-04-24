import asyncio
import logging
import os
from tavily import TavilyClient
from backend.agent.base import BaseAgent
from backend.agent.prompts import RESEARCH_SYSTEM, RESEARCH_USER

log = logging.getLogger("vibe.search")

class SearchAgent(BaseAgent):
    """
    负责搜索章节相关资料并提炼成参考要点。

    流程：
    1. 调用 Tavily API 搜索，取前 3 条结果的摘要
    2. 调用 LLM 把摘要提炼成结构化参考要点
    3. 任何步骤失败都降级返回空字符串，不中断写作流程
    """

    def __init__(self):
        super().__init__()
        api_key = os.environ.get("TAVILY_API_KEY", "")
        if not api_key:
            log.warning("TAVILY_API_KEY not set — search will be skipped")
        self._tavily = TavilyClient(api_key=api_key)

    async def _search_one(self, query: str) -> list[dict]:
        """对单个查询词执行 Tavily 搜索，返回结果列表，失败返回空列表。"""
        try:
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: self._tavily.search(
                    query,
                    max_results=3,
                    search_depth="advanced",
                    # 只取近两年内容
                    days=730,
                ),
            )
            results = response.get("results", [])
            log.info("search ok  query=%r  results=%d  urls=%s",
                     query, len(results), [r.get("url", "")[:60] for r in results])
            return results
        except Exception as e:
            log.warning("search failed  query=%r  err=%s", query, e)
            return []

    async def search(self, queries: list[str], opinions: str) -> str:
        """
        根据论点驱动的搜索词列表搜索并提炼参考资料。
        - queries: OpinionAgent 生成的搜索词列表
        - opinions: 论点文本，用于指导提炼方向
        返回提炼后的参考要点字符串；失败时返回空字符串。
        """
        if not os.environ.get("TAVILY_API_KEY"):
            log.warning("search skipped (no TAVILY_API_KEY)")
            return ""

        if not queries:
            return ""

        # 并行搜索所有查询词
        tasks = [self._search_one(q) for q in queries]
        all_results_nested = await asyncio.gather(*tasks)

        # 去重合并（按 url 去重）
        seen_urls: set[str] = set()
        merged: list[dict] = []
        for results in all_results_nested:
            for r in results:
                url = r.get("url", "")
                if url not in seen_urls:
                    seen_urls.add(url)
                    merged.append(r)

        if not merged:
            log.warning("all searches returned 0 results  queries=%s", queries)
            return ""

        snippets = "\n\n".join(
            f"[{i+1}] {r['content']}" for i, r in enumerate(merged)
        )

        research = await self._call_llm(
            RESEARCH_SYSTEM,
            RESEARCH_USER.format(query=opinions, snippets=snippets),
            max_tokens=600,
        )
        log.info("research distilled  queries=%s  len=%d", queries, len(research))
        return research
