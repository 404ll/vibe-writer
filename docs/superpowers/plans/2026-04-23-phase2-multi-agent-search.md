# vibe-writer Phase 2: Multi-Agent Architecture + Tavily Search

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将单体 Orchestrator 拆分为 PlannerAgent / SearchAgent / WriterAgent 三个职责单一的 Agent，并在每章写作前通过 Tavily 搜索 + LLM 提炼注入参考资料，提升内容质量。

**Architecture:** Orchestrator 退化为纯协调者，不再持有 LLM 客户端；PlannerAgent 负责生成大纲；SearchAgent 调用 Tavily 搜索后用 LLM 提炼成结构化参考资料；WriterAgent 接收参考资料写章节正文。搜索失败时自动降级（返回空字符串），写作不中断。

**Tech Stack:** Python 3.11+, FastAPI, `anthropic` SDK, `tavily-python==0.3.3`, asyncio, SSE

---

## File Map

| File | 变更 | 职责 |
|------|------|------|
| `backend/agent/planner.py` | 新建 | PlannerAgent：生成大纲 + 解析章节列表 |
| `backend/agent/search.py` | 新建 | SearchAgent：Tavily 搜索 + LLM 提炼 |
| `backend/agent/writer.py` | 新建 | WriterAgent：根据参考资料写章节正文 |
| `backend/agent/base.py` | 新建 | BaseAgent：共享 LLM 客户端初始化逻辑 |
| `backend/agent/orchestrator.py` | 重构 | 退化为协调者，委托给三个 Agent |
| `backend/agent/prompts.py` | 修改 | 新增 RESEARCH_SYSTEM/USER；CHAPTER_USER 增加 research 字段 |
| `backend/requirements.txt` | 修改 | 添加 `tavily-python==0.3.3` |
| `.env` | 修改 | 添加 `TAVILY_API_KEY` |
| `tests/test_planner.py` | 新建 | PlannerAgent 单测 |
| `tests/test_search.py` | 新建 | SearchAgent 单测（mock Tavily + mock LLM） |
| `tests/test_writer.py` | 新建 | WriterAgent 单测（mock LLM） |
| `tests/test_orchestrator.py` | 修改 | 更新为 mock 三个 Agent |

---

## Task 1: BaseAgent + PlannerAgent

**Files:**
- Create: `backend/agent/base.py`
- Create: `backend/agent/planner.py`
- Create: `tests/test_planner.py`

- [ ] **Step 1: 写失败测试**

Create `tests/test_planner.py`:
```python
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from backend.agent.planner import PlannerAgent

@pytest.mark.asyncio
async def test_plan_returns_chapter_list():
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="1. 什么是 Agent\n2. 核心组件\n3. 实战案例")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = PlannerAgent()
        chapters = await agent.plan("AI Agents 入门")

    assert chapters == ["什么是 Agent", "核心组件", "实战案例"]

@pytest.mark.asyncio
async def test_plan_handles_empty_lines():
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="1. 章节一\n\n2. 章节二\n")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = PlannerAgent()
        chapters = await agent.plan("测试主题")

    assert chapters == ["章节一", "章节二"]
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /path/to/vibe-writer && python3 -m pytest tests/test_planner.py -v
# Expected: ModuleNotFoundError: No module named 'backend.agent.planner'
```

- [ ] **Step 3: 创建 BaseAgent**

Create `backend/agent/base.py`:
```python
import os
import anthropic

class BaseAgent:
    """
    所有 Agent 的基类，统一初始化 LLM 客户端。
    子类通过 self._client 和 self._call_llm() 调用 LLM。
    """

    def __init__(self):
        self._client = anthropic.AsyncAnthropic(
            api_key=os.environ.get("ANTHROPIC_API_KEY", "placeholder"),
            base_url=os.environ.get("ANTHROPIC_BASE_URL"),
        )

    async def _call_llm(self, system: str, user: str, max_tokens: int = 2048) -> str:
        """封装单次 LLM 调用，返回纯文本响应"""
        message = await self._client.messages.create(
            model=os.environ.get("MODEL_ID", "kimi-k2.5"),
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return message.content[0].text
```

- [ ] **Step 4: 创建 PlannerAgent**

Create `backend/agent/planner.py`:
```python
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
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /path/to/vibe-writer && python3 -m pytest tests/test_planner.py -v
# Expected: 2 passed
```

- [ ] **Step 6: Commit**

```bash
git add backend/agent/base.py backend/agent/planner.py tests/test_planner.py
git commit -m "feat: BaseAgent and PlannerAgent"
```

---

## Task 2: SearchAgent

**Files:**
- Create: `backend/agent/search.py`
- Modify: `backend/agent/prompts.py`
- Modify: `backend/requirements.txt`
- Modify: `.env`
- Create: `tests/test_search.py`

- [ ] **Step 1: 更新 requirements.txt**

在 `backend/requirements.txt` 末尾添加：
```
tavily-python==0.3.3
```

安装：
```bash
pip3 install tavily-python==0.3.3
```

- [ ] **Step 2: 更新 .env**

在 `.env` 末尾添加：
```
TAVILY_API_KEY=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
```

- [ ] **Step 3: 在 prompts.py 新增 RESEARCH 提示词**

在 `backend/agent/prompts.py` 末尾追加：
```python
RESEARCH_SYSTEM = """你是一位研究助手。用户给你一组网络搜索摘要，请提炼出其中对技术博客写作最有价值的信息。
要求：
- 保留具体的技术事实、数据、案例
- 去掉广告、无关内容、重复信息
- 输出结构化的参考要点，每点一行，以 "- " 开头
- 总字数不超过 300 字
只输出提炼后的要点，不要其他内容。"""

RESEARCH_USER = """搜索主题：{query}

搜索结果摘要：
{snippets}

请提炼出对撰写该主题技术博客最有价值的参考要点。"""
```

- [ ] **Step 4: 写失败测试**

Create `tests/test_search.py`:
```python
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from backend.agent.search import SearchAgent

@pytest.mark.asyncio
async def test_search_returns_research_string():
    # mock Tavily 客户端
    mock_tavily = MagicMock()
    mock_tavily.search = MagicMock(return_value={
        "results": [
            {"content": "Agent 是能自主执行任务的 AI 系统"},
            {"content": "LangChain 是常用的 Agent 框架"},
        ]
    })

    # mock LLM 提炼
    mock_llm_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="- Agent 能自主执行任务\n- LangChain 是常用框架")]
    mock_llm_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.search.TavilyClient", return_value=mock_tavily), \
         patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_llm_client):
        agent = SearchAgent()
        result = await agent.search("AI Agent 入门")

    assert "Agent" in result
    assert isinstance(result, str)

@pytest.mark.asyncio
async def test_search_returns_empty_string_on_failure():
    """搜索失败时降级返回空字符串，不抛异常"""
    mock_tavily = MagicMock()
    mock_tavily.search = MagicMock(side_effect=Exception("API error"))

    with patch("backend.agent.search.TavilyClient", return_value=mock_tavily):
        agent = SearchAgent()
        result = await agent.search("任意主题")

    assert result == ""

@pytest.mark.asyncio
async def test_search_returns_empty_string_when_no_results():
    """搜索无结果时返回空字符串"""
    mock_tavily = MagicMock()
    mock_tavily.search = MagicMock(return_value={"results": []})

    with patch("backend.agent.search.TavilyClient", return_value=mock_tavily):
        agent = SearchAgent()
        result = await agent.search("任意主题")

    assert result == ""
```

- [ ] **Step 5: 运行测试确认失败**

```bash
cd /path/to/vibe-writer && python3 -m pytest tests/test_search.py -v
# Expected: ModuleNotFoundError: No module named 'backend.agent.search'
```

- [ ] **Step 6: 创建 SearchAgent**

Create `backend/agent/search.py`:
```python
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
            # Step 1: Tavily 搜索
            response = self._tavily.search(query, max_results=3)
            results = response.get("results", [])
            if not results:
                return ""

            # Step 2: 拼接摘要
            snippets = "\n\n".join(
                f"[{i+1}] {r['content']}" for i, r in enumerate(results)
            )

            # Step 3: LLM 提炼
            research = await self._call_llm(
                RESEARCH_SYSTEM,
                RESEARCH_USER.format(query=query, snippets=snippets),
                max_tokens=512,
            )
            return research

        except Exception:
            # 搜索或提炼失败时静默降级，写作不中断
            return ""
```

- [ ] **Step 7: 运行测试确认通过**

```bash
cd /path/to/vibe-writer && python3 -m pytest tests/test_search.py -v
# Expected: 3 passed
```

- [ ] **Step 8: Commit**

```bash
git add backend/agent/search.py backend/agent/prompts.py backend/requirements.txt .env tests/test_search.py
git commit -m "feat: SearchAgent — Tavily search + LLM research distillation"
```

---

## Task 3: WriterAgent

**Files:**
- Create: `backend/agent/writer.py`
- Modify: `backend/agent/prompts.py`
- Create: `tests/test_writer.py`

- [ ] **Step 1: 更新 prompts.py 中的 CHAPTER_USER，加入 research 字段**

将 `backend/agent/prompts.py` 中的 `CHAPTER_USER` 替换为：
```python
CHAPTER_USER = """文章主题：{topic}
完整大纲：
{outline}

参考资料：
{research}

请撰写章节「{chapter_title}」的正文内容。"""
```

- [ ] **Step 2: 写失败测试**

Create `tests/test_writer.py`:
```python
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from backend.agent.writer import WriterAgent

@pytest.mark.asyncio
async def test_write_returns_content_string():
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="这是章节正文内容")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = WriterAgent()
        content = await agent.write(
            topic="AI Agents 入门",
            outline="1. 什么是 Agent\n2. 核心组件",
            chapter_title="什么是 Agent",
            research="- Agent 能自主执行任务",
        )

    assert content == "这是章节正文内容"
    # 验证 research 被注入进了 prompt
    call_args = mock_client.messages.create.call_args
    user_content = call_args.kwargs["messages"][0]["content"]
    assert "Agent 能自主执行任务" in user_content

@pytest.mark.asyncio
async def test_write_works_without_research():
    """research 为空字符串时正常写作"""
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="没有参考资料也能写")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = WriterAgent()
        content = await agent.write(
            topic="测试主题",
            outline="1. 章节一",
            chapter_title="章节一",
            research="",
        )

    assert content == "没有参考资料也能写"
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd /path/to/vibe-writer && python3 -m pytest tests/test_writer.py -v
# Expected: ModuleNotFoundError: No module named 'backend.agent.writer'
```

- [ ] **Step 4: 创建 WriterAgent**

Create `backend/agent/writer.py`:
```python
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
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /path/to/vibe-writer && python3 -m pytest tests/test_writer.py -v
# Expected: 2 passed
```

- [ ] **Step 6: Commit**

```bash
git add backend/agent/writer.py backend/agent/prompts.py tests/test_writer.py
git commit -m "feat: WriterAgent — chapter writing with research injection"
```

---

## Task 4: 重构 Orchestrator

**Files:**
- Modify: `backend/agent/orchestrator.py`
- Modify: `tests/test_orchestrator.py`

- [ ] **Step 1: 写新的 orchestrator 测试**

将 `tests/test_orchestrator.py` 完整替换为：
```python
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from backend.agent.orchestrator import Orchestrator
from backend.store import JobStore

@pytest.mark.asyncio
async def test_orchestrator_calls_all_agents(monkeypatch):
    """验证 Orchestrator 依次调用 PlannerAgent、SearchAgent、WriterAgent"""
    events = []

    async def fake_push(job_id, event):
        events.append(event)

    monkeypatch.setattr("backend.agent.orchestrator.push_event", fake_push)

    # mock 三个 Agent
    mock_planner = MagicMock()
    mock_planner.plan = AsyncMock(return_value=["章节一", "章节二"])

    mock_search = MagicMock()
    mock_search.search = AsyncMock(return_value="- 参考要点")

    mock_writer = MagicMock()
    mock_writer.write = AsyncMock(return_value="章节正文内容")

    # 创建真实 job
    store = JobStore()
    job = store.create_job("测试主题")

    with patch("backend.agent.orchestrator.job_store", store), \
         patch("backend.agent.orchestrator.PlannerAgent", return_value=mock_planner), \
         patch("backend.agent.orchestrator.SearchAgent", return_value=mock_search), \
         patch("backend.agent.orchestrator.WriterAgent", return_value=mock_writer):
        orch = Orchestrator(job.id, "测试主题", intervention_on_outline=False)
        await orch.run()

    # 验证每个 Agent 被调用
    mock_planner.plan.assert_called_once_with("测试主题")
    assert mock_search.search.call_count == 2   # 两章各搜索一次
    assert mock_writer.write.call_count == 2    # 两章各写一次

    # 验证 SSE 事件序列
    event_types = [e.event for e in events]
    assert "outline_ready" in event_types
    assert "chapter_done" in event_types
    assert "done" in event_types

@pytest.mark.asyncio
async def test_orchestrator_continues_when_search_fails(monkeypatch):
    """SearchAgent 返回空字符串时，写作正常继续"""
    events = []

    async def fake_push(job_id, event):
        events.append(event)

    monkeypatch.setattr("backend.agent.orchestrator.push_event", fake_push)

    mock_planner = MagicMock()
    mock_planner.plan = AsyncMock(return_value=["章节一"])

    mock_search = MagicMock()
    mock_search.search = AsyncMock(return_value="")  # 搜索失败，返回空

    mock_writer = MagicMock()
    mock_writer.write = AsyncMock(return_value="无参考资料的章节内容")

    store = JobStore()
    job = store.create_job("测试主题")

    with patch("backend.agent.orchestrator.job_store", store), \
         patch("backend.agent.orchestrator.PlannerAgent", return_value=mock_planner), \
         patch("backend.agent.orchestrator.SearchAgent", return_value=mock_search), \
         patch("backend.agent.orchestrator.WriterAgent", return_value=mock_writer):
        orch = Orchestrator(job.id, "测试主题", intervention_on_outline=False)
        await orch.run()

    # 写作依然被调用，research 参数为空字符串
    mock_writer.write.assert_called_once()
    call_kwargs = mock_writer.write.call_args.kwargs
    assert call_kwargs["research"] == ""

    event_types = [e.event for e in events]
    assert "done" in event_types
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /path/to/vibe-writer && python3 -m pytest tests/test_orchestrator.py -v
# Expected: ImportError（Orchestrator 还没重构，PlannerAgent 等未被导入）
```

- [ ] **Step 3: 重构 Orchestrator**

将 `backend/agent/orchestrator.py` 完整替换为：
```python
import os
import re
from backend.models import StageStatus, SSEEvent
from backend.store import job_store
from backend.routers.jobs import push_event
from backend.agent.planner import PlannerAgent
from backend.agent.search import SearchAgent
from backend.agent.writer import WriterAgent

class Orchestrator:
    """
    流水线协调者：不再持有 LLM 客户端，只负责调度三个 Agent 并管理阶段状态。

    阶段：
      PLAN  → PlannerAgent 生成大纲
      WRITE → 每章：SearchAgent 搜索 → WriterAgent 写作
      EXPORT → 拼接 Markdown，写文件
    """

    def __init__(self, job_id: str, topic: str, intervention_on_outline: bool = True, intervention_on_chapter: bool = False):
        self.job_id = job_id
        self.topic = topic
        self.intervention_on_outline = intervention_on_outline
        self.intervention_on_chapter = intervention_on_chapter
        # 初始化三个 Agent
        self._planner = PlannerAgent()
        self._search = SearchAgent()
        self._writer = WriterAgent()

    def _safe_filename(self, text: str, max_len: int = 30) -> str:
        """把主题字符串转成安全的文件名"""
        slug = re.sub(r'[^\w\-\u4e00-\u9fff]', '-', text)
        slug = re.sub(r'-+', '-', slug)
        return slug[:max_len].rstrip('-') or 'output'

    async def run(self):
        """主流水线：PLAN → WRITE → EXPORT"""
        job = job_store.get(self.job_id)
        if not job:
            await push_event(self.job_id, SSEEvent(
                event="error", data={"message": "Job not found"}
            ))
            return

        # ── Stage 1: PLAN ──────────────────────────────────────────
        await push_event(self.job_id, SSEEvent(
            event="stage_update", data={"stage": StageStatus.PLAN}
        ))

        # 委托给 PlannerAgent
        chapters = await self._planner.plan(self.topic)
        job.outline = chapters
        job_store.update(job)

        await push_event(self.job_id, SSEEvent(
            event="outline_ready",
            data={"outline": chapters},
        ))

        if self.intervention_on_outline:
            reply = await job_store.wait_for_reply(self.job_id)
            # 用户可以发送新大纲文本，Planner 重新解析
            if reply and reply.strip().lower() not in ("ok", "确认", "继续", "yes"):
                revised = self._planner._parse_outline(reply)
                chapters = revised if revised else chapters
                job.outline = chapters
                job_store.update(job)

        # ── Stage 2: WRITE ─────────────────────────────────────────
        job.stage = StageStatus.WRITE
        job_store.update(job)
        await push_event(self.job_id, SSEEvent(
            event="stage_update", data={"stage": StageStatus.WRITE}
        ))

        outline_text = "\n".join(f"{i+1}. {c}" for i, c in enumerate(chapters))
        written_chapters = []

        for chapter_title in chapters:
            # 搜索参考资料（失败时返回空字符串，写作继续）
            await push_event(self.job_id, SSEEvent(
                event="searching", data={"title": chapter_title}
            ))
            research = await self._search.search(chapter_title)

            # 写章节正文
            content = await self._writer.write(
                topic=self.topic,
                outline=outline_text,
                chapter_title=chapter_title,
                research=research,
            )
            written_chapters.append({"title": chapter_title, "content": content})
            job.chapters = written_chapters
            job_store.update(job)

            await push_event(self.job_id, SSEEvent(
                event="chapter_done",
                data={"title": chapter_title, "index": len(written_chapters) - 1},
            ))

            if self.intervention_on_chapter:
                await job_store.wait_for_reply(self.job_id)

        # ── Stage 3: EXPORT ────────────────────────────────────────
        job.stage = StageStatus.EXPORT
        job_store.update(job)
        await push_event(self.job_id, SSEEvent(
            event="stage_update", data={"stage": StageStatus.EXPORT}
        ))

        markdown = self._build_markdown(self.topic, written_chapters)
        output_path = f"output/{self._safe_filename(self.topic)}.md"
        os.makedirs("output", exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(markdown)

        job.stage = StageStatus.DONE
        job_store.update(job)
        await push_event(self.job_id, SSEEvent(
            event="done", data={"output_path": output_path},
        ))

    def _build_markdown(self, topic: str, chapters: list[dict]) -> str:
        """把章节列表拼成标准 Markdown 文档"""
        lines = [f"# {topic}\n"]
        for ch in chapters:
            lines.append(f"\n## {ch['title']}\n")
            lines.append(ch["content"])
        return "\n".join(lines)
```

- [ ] **Step 4: 运行所有测试确认通过**

```bash
cd /path/to/vibe-writer && python3 -m pytest tests/ -v
# Expected: 全部通过（test_planner: 2, test_search: 3, test_writer: 2, test_orchestrator: 2, test_store: 3, test_jobs_router: 3）
```

- [ ] **Step 5: Commit**

```bash
git add backend/agent/orchestrator.py tests/test_orchestrator.py
git commit -m "refactor: Orchestrator delegates to PlannerAgent/SearchAgent/WriterAgent"
```

---

## Task 5: E2E 验证

**Files:** 无新文件，手动验证

- [ ] **Step 1: 确认后端已启动**

```bash
python3 -m uvicorn backend.main:app --port 8000
# 如果已在运行则跳过
```

- [ ] **Step 2: 发起一次无介入的完整请求**

```bash
JOB=$(curl -s -X POST http://localhost:8000/jobs \
  -H "Content-Type: application/json" \
  -d '{"topic":"RAG 检索增强生成","intervention":{"on_outline":false,"on_chapter":false}}')
JOB_ID=$(echo $JOB | python3 -c "import sys,json; print(json.load(sys.stdin)['job_id'])")
echo "Job ID: $JOB_ID"
curl -N http://localhost:8000/jobs/$JOB_ID/stream
```

- [ ] **Step 3: 验证 SSE 事件序列**

Expected 事件顺序：
```
event: stage_update   data: {"stage": "plan"}
event: outline_ready  data: {"outline": [...]}
event: stage_update   data: {"stage": "write"}
event: searching      data: {"title": "章节一"}   ← 新增
event: chapter_done   data: {"title": "章节一", "index": 0}
event: searching      data: {"title": "章节二"}   ← 新增
event: chapter_done   data: {"title": "章节二", "index": 1}
...
event: stage_update   data: {"stage": "export"}
event: done           data: {"output_path": "output/...md"}
```

- [ ] **Step 4: 验证输出文件内容质量**

```bash
cat output/RAG-检索增强生成.md | head -60
# 验证章节内容比 Phase 1 更丰富（引用了搜索资料）
```

- [ ] **Step 5: Final commit**

```bash
git add .
git commit -m "chore: Phase 2 E2E smoke test passes"
```

---

## Self-Review Checklist

### Spec Coverage

| Spec 要求 | Task |
|-----------|------|
| PlannerAgent（大纲生成） | Task 1 |
| SearchAgent（Tavily + LLM 提炼） | Task 2 |
| WriterAgent（注入 research 写作） | Task 3 |
| Orchestrator 重构为协调者 | Task 4 |
| 搜索失败降级处理 | Task 2 + Task 4 |
| `searching` SSE 事件 | Task 4 |
| 全量测试通过 | Task 4 Step 4 |

### 类型一致性

- `PlannerAgent.plan()` 返回 `list[str]`，Orchestrator 接收 `chapters: list[str]` ✓
- `SearchAgent.search()` 返回 `str`，WriterAgent.write() 接收 `research: str` ✓
- `WriterAgent.write()` 参数：`topic, outline, chapter_title, research` 均为 `str` ✓
- `CHAPTER_USER` 占位符：`{topic}`, `{outline}`, `{chapter_title}`, `{research}` ✓
