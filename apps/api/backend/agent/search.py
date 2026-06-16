import asyncio
import logging
import os
import re
from datetime import date, datetime
from tavily import TavilyClient
from backend.agent.base import BaseAgent
from backend.agent.prompts import RESEARCH_SYSTEM, RESEARCH_USER

log = logging.getLogger("vibe.search")

# 新闻/时效类查询：缩短检索窗口、提高近期权重
_NEWS_QUERY_RE = re.compile(
    r"新闻|最新|近期|今年|20\d{2}|政策|监管|价格|市场|财报|发布|上线|"
    r"案例|事故|漏洞|攻击|融资|并购|占比|统计|报告",
    re.I,
)


def _is_news_like_query(query: str) -> bool:
    return bool(_NEWS_QUERY_RE.search(query))


def _parse_published_date(raw: str | None) -> datetime | None:
    if not raw:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y/%m/%d"):
        try:
            return datetime.strptime(raw[:19], fmt)
        except ValueError:
            continue
    return None


def _rank_results_by_recency(results: list[dict], news_like: bool) -> list[dict]:
    """按发布时间排序；新闻类查询更强调近期。"""
    today = datetime.utcnow()

    def score(r: dict) -> float:
        published = _parse_published_date(r.get("published_date") or r.get("published"))
        if published:
            age_days = max(0, (today - published).days)
            if news_like:
                return -age_days  # 越新分数越高
            return -age_days * 0.5
        return -365.0  # 无日期排后

    return sorted(results, key=score, reverse=True)


class SearchAgent(BaseAgent):
    """
    负责搜索章节相关资料并提炼成参考要点。

    流程：
    1. 调用 Tavily API 搜索，按时效重排后取前几条
    2. 调用 LLM 把摘要提炼成结构化参考要点
    3. 任何步骤失败都降级返回空字符串，不中断写作流程
    """

    def __init__(self):
        super().__init__()
        api_key = os.environ.get("TAVILY_API_KEY", "")
        if not api_key:
            log.warning("TAVILY_API_KEY not set — search will be skipped")
        self._tavily = TavilyClient(api_key=api_key)

    def _search_params(self, query: str) -> dict:
        news_like = _is_news_like_query(query)
        return {
            "max_results": 5,
            "search_depth": "advanced",
            # 新闻类：近 90 天；一般技术：近 1 年
            "days": 90 if news_like else 365,
            **({"topic": "news"} if news_like else {}),
        }

    async def _search_one(self, query: str) -> list[dict]:
        """对单个查询词执行 Tavily 搜索，返回按时效排序的结果列表。"""
        try:
            params = self._search_params(query)
            loop = asyncio.get_running_loop()
            response = await loop.run_in_executor(
                None,
                lambda: self._tavily.search(query, **params),
            )
            results = response.get("results", [])
            news_like = _is_news_like_query(query)
            ranked = _rank_results_by_recency(results, news_like)[:3]
            log.info(
                "search ok  query=%r  news=%s  results=%d  urls=%s",
                query,
                news_like,
                len(ranked),
                [r.get("url", "")[:60] for r in ranked],
            )
            return ranked
        except Exception as e:
            log.warning("search failed  query=%r  err=%s", query, e)
            return []

    def _format_snippets(self, results: list[dict]) -> str:
        lines = []
        for i, r in enumerate(results):
            pub = r.get("published_date") or r.get("published") or "日期未知"
            lines.append(f"[{i + 1}] 发布时间: {pub}\n{r.get('content', '')}")
        return "\n\n".join(lines)

    async def search_one(self, query: str) -> str:
        """
        Writer 工具调用的入口：单次搜索并提炼结果。
        供 WriterAgent 通过 search_fn 注入后按需调用。
        """
        if not os.environ.get("TAVILY_API_KEY"):
            log.warning("search_one skipped (no TAVILY_API_KEY)")
            return "（搜索不可用）"

        results = await self._search_one(query)
        if not results:
            return "（未找到相关资料）"

        snippets = self._format_snippets(results)
        distilled = await self._call_llm(
            RESEARCH_SYSTEM,
            RESEARCH_USER.format(query=query, snippets=snippets),
            max_tokens=1024,
        )
        log.info("search_one done  query=%r  len=%d", query, len(distilled))
        return distilled

    async def search(self, queries: list[str], opinions: str) -> str:
        """
        根据搜索词列表搜索并提炼参考资料。
        返回提炼后的参考要点字符串；失败时返回空字符串。
        """
        if not os.environ.get("TAVILY_API_KEY"):
            log.warning("search skipped (no TAVILY_API_KEY)")
            return ""

        if not queries:
            return ""

        tasks = [self._search_one(q) for q in queries]
        all_results_nested = await asyncio.gather(*tasks)

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

        merged = _rank_results_by_recency(merged, _is_news_like_query(opinions))
        snippets = self._format_snippets(merged[:6])

        research = await self._call_llm(
            RESEARCH_SYSTEM,
            RESEARCH_USER.format(query=opinions, snippets=snippets),
            max_tokens=1024,
        )
        log.info("research distilled  queries=%s  len=%d", queries, len(research))
        return research
