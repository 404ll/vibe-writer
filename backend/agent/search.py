import asyncio
import os
from tavily import TavilyClient
from backend.agent.base import BaseAgent
from backend.agent.prompts import RESEARCH_SYSTEM, RESEARCH_USER

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
        self._tavily = TavilyClient(api_key=os.environ.get("TAVILY_API_KEY", ""))

    async def search(self, query: str) -> str:
        """
        搜索并提炼参考资料。
        返回提炼后的参考要点字符串；失败时返回空字符串。
        """
        try:
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None, lambda: self._tavily.search(query, max_results=3)
            )
            results = response.get("results", [])
            if not results:
                return ""

            snippets = "\n\n".join(
                f"[{i+1}] {r['content']}" for i, r in enumerate(results)
            )

            research = await self._call_llm(
                RESEARCH_SYSTEM,
                RESEARCH_USER.format(query=query, snippets=snippets),
                max_tokens=512,
            )
            return research

        except Exception:
            return ""
