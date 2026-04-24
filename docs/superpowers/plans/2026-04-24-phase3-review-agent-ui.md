# Phase 3: ReviewAgent + UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入 ReviewAgent（轻审 + 重审，不通过自动重写一次），并重设计前端 UI（浅色科技感，新增 ActivityPanel 实时展示进度）。

**Architecture:** 后端新增 `ReviewAgent`，`WriterAgent.write()` 扩展 `review_feedback` 参数，Orchestrator 在 WRITE 阶段每章后调用轻审、新增 REVIEW 阶段调用重审；前端新增 `ActivityPanel` 组件，重设计所有组件样式，修复无障碍问题。

**Tech Stack:** Python 3.9+, FastAPI, anthropic SDK, React 18, TypeScript, Vite, CSS variables

---

## File Map

### 后端

| 文件 | 变更 | 职责 |
|------|------|------|
| `backend/agent/reviewer.py` | 新建 | ReviewAgent + ReviewResult dataclass |
| `backend/agent/prompts.py` | 修改 | 新增 CHAPTER_REVIEW_SYSTEM/USER、FULL_REVIEW_SYSTEM/USER |
| `backend/agent/writer.py` | 修改 | `write()` 新增 `review_feedback: str = ""` 参数 |
| `backend/agent/orchestrator.py` | 修改 | 接入 ReviewAgent，新增 REVIEW 阶段 |
| `backend/models.py` | 修改 | StageStatus 新增 REVIEW |
| `tests/test_reviewer.py` | 新建 | ReviewAgent 单测 |
| `tests/test_writer.py` | 修改 | 补充 review_feedback 测试 |
| `tests/test_orchestrator.py` | 修改 | mock ReviewAgent，验证新 SSE 事件 |

### 前端

| 文件 | 变更 | 职责 |
|------|------|------|
| `frontend/src/types.ts` | 修改 | 新增 ReviewResult、ActivityEntry，扩展 SSEEventType、StageStatus |
| `frontend/src/hooks/useJobStream.ts` | 修改 | 新增事件类型监听 |
| `frontend/src/components/InputPanel.tsx` | 修改 | 无障碍修复 + 样式重设计 |
| `frontend/src/components/StagePanel.tsx` | 修改 | 新增 review 阶段 + 步进条样式 |
| `frontend/src/components/ReviewPanel.tsx` | 修改 | 无障碍修复 + 样式重设计 |
| `frontend/src/components/ActivityPanel.tsx` | 新建 | 实时活动日志 |
| `frontend/src/App.tsx` | 修改 | 新增状态 + 处理新 SSE 事件 |
| `frontend/src/index.css` | 修改 | CSS 变量覆盖为科技感浅色主题 |

---

## Task 1: ReviewAgent

**Files:**
- Create: `backend/agent/reviewer.py`
- Modify: `backend/agent/prompts.py`
- Create: `tests/test_reviewer.py`

- [ ] **Step 1: 在 prompts.py 末尾追加审稿 prompts**

在 `backend/agent/prompts.py` 末尾追加：

```python
CHAPTER_REVIEW_SYSTEM = """你是一位技术博客审稿人。请审阅给定的章节内容，检查以下两点：
1. 连贯性：与大纲中其他章节是否衔接自然，不重复也不跳跃
2. 完整度：章节标题是否被充分展开（内容不少于 200 字，有实质性讲解）

输出格式（严格遵守，只输出这两种之一）：
PASSED
或
FAILED
理由：xxx
建议：xxx"""

CHAPTER_REVIEW_USER = """文章大纲：
{outline}

当前章节标题：{chapter_title}

章节内容：
{content}

请审阅以上章节。"""

FULL_REVIEW_SYSTEM = """你是一位技术博客审稿人。请审阅完整文章的每一章，检查：
1. 整体可读性：行文是否流畅，逻辑是否清晰
2. 技术准确性：技术描述是否正确
3. 章节间连贯性：各章是否自然衔接

对每章分别输出结果，格式严格如下（N 为章节序号，从 1 开始）：
章节1: PASSED
章节2: FAILED
理由：xxx
建议：xxx
章节3: PASSED
（以此类推，每章必须有结果）"""

FULL_REVIEW_USER = """文章主题：{topic}

完整文章：
{full_text}

请逐章审阅。"""
```

- [ ] **Step 2: 写失败测试**

创建 `tests/test_reviewer.py`：

```python
import pytest
from dataclasses import dataclass
from unittest.mock import AsyncMock, MagicMock, patch
from backend.agent.reviewer import ReviewAgent, ReviewResult


@pytest.mark.asyncio
async def test_review_chapter_passed():
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="PASSED")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = ReviewAgent()
        result = await agent.review_chapter(
            chapter_title="什么是 Agent",
            content="Agent 是能自主执行任务的 AI 系统..." * 10,
            outline="1. 什么是 Agent\n2. 核心组件",
        )

    assert result.passed is True
    assert result.feedback == ""


@pytest.mark.asyncio
async def test_review_chapter_failed():
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="FAILED\n理由：内容过短\n建议：补充实际案例")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = ReviewAgent()
        result = await agent.review_chapter(
            chapter_title="核心组件",
            content="很短的内容",
            outline="1. 什么是 Agent\n2. 核心组件",
        )

    assert result.passed is False
    assert "内容过短" in result.feedback


@pytest.mark.asyncio
async def test_review_full_returns_per_chapter_results():
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="章节1: PASSED\n章节2: FAILED\n理由：逻辑跳跃\n建议：加过渡段")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = ReviewAgent()
        results = await agent.review_full(
            topic="AI Agents 入门",
            chapters=[
                {"title": "什么是 Agent", "content": "内容一"},
                {"title": "核心组件", "content": "内容二"},
            ],
        )

    assert len(results) == 2
    assert results[0].passed is True
    assert results[1].passed is False
    assert "逻辑跳跃" in results[1].feedback


@pytest.mark.asyncio
async def test_review_full_fallback_when_parse_fails():
    """LLM 输出格式异常时，所有章节默认 PASSED（不中断流程）"""
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="无法解析的输出")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = ReviewAgent()
        results = await agent.review_full(
            topic="测试",
            chapters=[{"title": "章节一", "content": "内容"}],
        )

    assert len(results) == 1
    assert results[0].passed is True
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_reviewer.py -v
# Expected: ModuleNotFoundError: No module named 'backend.agent.reviewer'
```

- [ ] **Step 4: 创建 ReviewAgent**

创建 `backend/agent/reviewer.py`：

```python
import re
from dataclasses import dataclass, field
from backend.agent.base import BaseAgent
from backend.agent.prompts import (
    CHAPTER_REVIEW_SYSTEM, CHAPTER_REVIEW_USER,
    FULL_REVIEW_SYSTEM, FULL_REVIEW_USER,
)


@dataclass
class ReviewResult:
    passed: bool
    feedback: str = field(default="")


class ReviewAgent(BaseAgent):
    """
    审稿 Agent，提供两种审稿模式：
    - review_chapter: 轻审，检查单章连贯性和完整度
    - review_full: 重审，检查全文整体质量
    两种模式不通过时均返回 feedback，由 Orchestrator 决定是否重写。
    """

    async def review_chapter(
        self,
        chapter_title: str,
        content: str,
        outline: str,
    ) -> ReviewResult:
        """轻审：连贯性 + 内容完整度。返回 ReviewResult。"""
        raw = await self._call_llm(
            CHAPTER_REVIEW_SYSTEM,
            CHAPTER_REVIEW_USER.format(
                outline=outline,
                chapter_title=chapter_title,
                content=content,
            ),
            max_tokens=512,
        )
        return self._parse_chapter_result(raw)

    async def review_full(
        self,
        topic: str,
        chapters: list[dict],
    ) -> list[ReviewResult]:
        """重审：全文整体质量。返回与 chapters 等长的 ReviewResult 列表。"""
        full_text = "\n\n".join(
            f"## {ch['title']}\n{ch['content']}" for ch in chapters
        )
        raw = await self._call_llm(
            FULL_REVIEW_SYSTEM,
            FULL_REVIEW_USER.format(topic=topic, full_text=full_text),
            max_tokens=1024,
        )
        results = self._parse_full_results(raw, len(chapters))
        return results

    def _parse_chapter_result(self, raw: str) -> ReviewResult:
        """解析轻审输出：PASSED 或 FAILED + 理由/建议。"""
        raw = raw.strip()
        if raw.startswith("PASSED"):
            return ReviewResult(passed=True, feedback="")
        # FAILED 分支：提取理由和建议
        feedback_lines = []
        for line in raw.splitlines():
            if line.startswith("FAILED"):
                continue
            feedback_lines.append(line)
        return ReviewResult(passed=False, feedback="\n".join(feedback_lines).strip())

    def _parse_full_results(self, raw: str, expected_count: int) -> list[ReviewResult]:
        """
        解析重审输出，格式：
          章节1: PASSED
          章节2: FAILED
          理由：xxx
          建议：xxx
        解析失败时所有章节默认 PASSED（不中断流程）。
        """
        results: list[ReviewResult] = []
        # 按"章节N:"分割
        segments = re.split(r'章节\d+:', raw)
        segments = [s.strip() for s in segments if s.strip()]

        for seg in segments:
            if seg.startswith("PASSED"):
                results.append(ReviewResult(passed=True, feedback=""))
            elif seg.startswith("FAILED"):
                feedback_lines = [
                    line for line in seg.splitlines()
                    if not line.startswith("FAILED")
                ]
                results.append(ReviewResult(
                    passed=False,
                    feedback="\n".join(feedback_lines).strip(),
                ))
            else:
                # 无法识别的格式，默认 PASSED
                results.append(ReviewResult(passed=True, feedback=""))

        # 数量不匹配时用 PASSED 填充（容错）
        while len(results) < expected_count:
            results.append(ReviewResult(passed=True, feedback=""))

        return results[:expected_count]
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_reviewer.py -v
# Expected: 4 passed
```

- [ ] **Step 6: 运行全量测试确认无回归**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/ -v
# Expected: 全部通过
```

- [ ] **Step 7: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add backend/agent/reviewer.py backend/agent/prompts.py tests/test_reviewer.py
git commit -m "feat: ReviewAgent — chapter review + full review with auto-rewrite support"
```

---

## Task 2: WriterAgent review_feedback 扩展

**Files:**
- Modify: `backend/agent/writer.py`
- Modify: `tests/test_writer.py`

- [ ] **Step 1: 在 test_writer.py 末尾追加失败测试**

在 `tests/test_writer.py` 末尾追加：

```python
@pytest.mark.asyncio
async def test_write_injects_review_feedback_into_prompt():
    """review_feedback 非空时，prompt 中应包含审稿意见"""
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="修改后的章节内容")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = WriterAgent()
        content = await agent.write(
            topic="AI Agents 入门",
            outline="1. 什么是 Agent",
            chapter_title="什么是 Agent",
            research="",
            review_feedback="内容过短，建议补充实际案例",
        )

    assert content == "修改后的章节内容"
    user_content = mock_client.messages.create.call_args.kwargs["messages"][0]["content"]
    assert "内容过短" in user_content
    assert "审稿意见" in user_content


@pytest.mark.asyncio
async def test_write_without_review_feedback_unchanged():
    """review_feedback 为空时，prompt 不包含审稿意见字样"""
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="正常章节内容")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = WriterAgent()
        await agent.write(
            topic="测试",
            outline="1. 章节一",
            chapter_title="章节一",
            research="",
            review_feedback="",
        )

    user_content = mock_client.messages.create.call_args.kwargs["messages"][0]["content"]
    assert "审稿意见" not in user_content
```

- [ ] **Step 2: 运行新测试确认失败**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_writer.py::test_write_injects_review_feedback_into_prompt -v
# Expected: TypeError (write() got unexpected keyword argument 'review_feedback')
```

- [ ] **Step 3: 修改 WriterAgent.write()**

将 `backend/agent/writer.py` 的 `write()` 方法替换为：

```python
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
    """
    research_text = research if research.strip() else "暂无参考资料"
    user_prompt = CHAPTER_USER.format(
        topic=topic,
        outline=outline,
        chapter_title=chapter_title,
        research=research_text,
    )
    if review_feedback.strip():
        user_prompt += f"\n\n审稿意见：{review_feedback}\n请根据以上意见修改章节内容。"
    return await self._call_llm(CHAPTER_SYSTEM, user_prompt)
```

- [ ] **Step 4: 运行全量测试确认通过**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/ -v
# Expected: 全部通过（含新增 2 个）
```

- [ ] **Step 5: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add backend/agent/writer.py tests/test_writer.py
git commit -m "feat: WriterAgent.write() accepts review_feedback for rewrite flow"
```

---

## Task 3: models.py — 新增 StageStatus.REVIEW

**Files:**
- Modify: `backend/models.py`

- [ ] **Step 1: 修改 StageStatus**

将 `backend/models.py` 中的 `StageStatus` 替换为：

```python
class StageStatus(str, Enum):
    PLAN = "plan"
    WRITE = "write"
    REVIEW = "review"
    EXPORT = "export"
    DONE = "done"
    ERROR = "error"
```

- [ ] **Step 2: 运行全量测试确认无回归**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/ -v
# Expected: 全部通过
```

- [ ] **Step 3: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add backend/models.py
git commit -m "feat: StageStatus adds REVIEW stage"
```

---

## Task 4: Orchestrator — 接入 ReviewAgent + REVIEW 阶段

**Files:**
- Modify: `backend/agent/orchestrator.py`
- Modify: `tests/test_orchestrator.py`

- [ ] **Step 1: 在 test_orchestrator.py 末尾追加失败测试**

在 `tests/test_orchestrator.py` 末尾追加：

```python
@pytest.mark.asyncio
async def test_orchestrator_calls_reviewer_per_chapter(monkeypatch):
    """每章写完后调用轻审；不通过时重写一次"""
    events = []

    async def fake_push(job_id, event):
        events.append(event)

    monkeypatch.setattr("backend.agent.orchestrator.push_event", fake_push)

    mock_planner = MagicMock()
    mock_planner.plan = AsyncMock(return_value=["章节一"])

    mock_search = MagicMock()
    mock_search.search = AsyncMock(return_value="")

    mock_writer = MagicMock()
    mock_writer.write = AsyncMock(return_value="章节内容")

    from backend.agent.reviewer import ReviewResult
    mock_reviewer = MagicMock()
    # 轻审返回 FAILED，触发重写；重审返回 PASSED
    mock_reviewer.review_chapter = AsyncMock(
        return_value=ReviewResult(passed=False, feedback="内容过短")
    )
    mock_reviewer.review_full = AsyncMock(
        return_value=[ReviewResult(passed=True, feedback="")]
    )

    store = JobStore()
    job = store.create_job("测试主题")

    with patch("backend.agent.orchestrator.job_store", store), \
         patch("backend.agent.orchestrator.PlannerAgent", return_value=mock_planner), \
         patch("backend.agent.orchestrator.SearchAgent", return_value=mock_search), \
         patch("backend.agent.orchestrator.WriterAgent", return_value=mock_writer), \
         patch("backend.agent.orchestrator.ReviewAgent", return_value=mock_reviewer):
        orch = Orchestrator(job.id, "测试主题", intervention_on_outline=False)
        await orch.run()

    # 轻审不通过 → writer 被调用 2 次（原写 + 重写）
    assert mock_writer.write.call_count == 2
    # 第二次调用应包含 review_feedback
    second_call_kwargs = mock_writer.write.call_args_list[1].kwargs
    assert second_call_kwargs["review_feedback"] == "内容过短"

    event_types = [e.event for e in events]
    assert "reviewing_chapter" in event_types
    assert "reviewing_full" in event_types
    assert "review_done" in event_types
    assert "done" in event_types


@pytest.mark.asyncio
async def test_orchestrator_review_full_rewrites_failed_chapters(monkeypatch):
    """重审不通过的章节各重写一次"""
    events = []

    async def fake_push(job_id, event):
        events.append(event)

    monkeypatch.setattr("backend.agent.orchestrator.push_event", fake_push)

    mock_planner = MagicMock()
    mock_planner.plan = AsyncMock(return_value=["章节一", "章节二"])

    mock_search = MagicMock()
    mock_search.search = AsyncMock(return_value="")

    mock_writer = MagicMock()
    mock_writer.write = AsyncMock(return_value="章节内容")

    from backend.agent.reviewer import ReviewResult
    mock_reviewer = MagicMock()
    # 轻审全部通过
    mock_reviewer.review_chapter = AsyncMock(
        return_value=ReviewResult(passed=True, feedback="")
    )
    # 重审：章节一通过，章节二不通过
    mock_reviewer.review_full = AsyncMock(
        return_value=[
            ReviewResult(passed=True, feedback=""),
            ReviewResult(passed=False, feedback="逻辑跳跃"),
        ]
    )

    store = JobStore()
    job = store.create_job("测试主题")

    with patch("backend.agent.orchestrator.job_store", store), \
         patch("backend.agent.orchestrator.PlannerAgent", return_value=mock_planner), \
         patch("backend.agent.orchestrator.SearchAgent", return_value=mock_search), \
         patch("backend.agent.orchestrator.WriterAgent", return_value=mock_writer), \
         patch("backend.agent.orchestrator.ReviewAgent", return_value=mock_reviewer):
        orch = Orchestrator(job.id, "测试主题", intervention_on_outline=False)
        await orch.run()

    # 2 章原写 + 1 章重审重写 = 3 次
    assert mock_writer.write.call_count == 3

    event_types = [e.event for e in events]
    assert "review_done" in event_types
    assert "done" in event_types
```

- [ ] **Step 2: 运行新测试确认失败**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_orchestrator.py::test_orchestrator_calls_reviewer_per_chapter -v
# Expected: ImportError 或 AssertionError（ReviewAgent 未接入）
```

- [ ] **Step 3: 重写 orchestrator.py**

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
from backend.agent.reviewer import ReviewAgent


class Orchestrator:
    """
    流水线协调者：调度 PlannerAgent / SearchAgent / WriterAgent / ReviewAgent。

    阶段：
      PLAN   → PlannerAgent 生成大纲
      WRITE  → 每章：搜索 → 写作 → 轻审（不通过重写一次）
      REVIEW → 重审全文（不通过的章节各重写一次）
      EXPORT → 拼接 Markdown，写文件
    """

    def __init__(
        self,
        job_id: str,
        topic: str,
        intervention_on_outline: bool = True,
        intervention_on_chapter: bool = False,
    ):
        self.job_id = job_id
        self.topic = topic
        self.intervention_on_outline = intervention_on_outline
        self.intervention_on_chapter = intervention_on_chapter
        self._planner = PlannerAgent()
        self._search = SearchAgent()
        self._writer = WriterAgent()
        self._reviewer = ReviewAgent()

    def _safe_filename(self, text: str, max_len: int = 30) -> str:
        slug = re.sub(r'[^\w\-\u4e00-\u9fff]', '-', text)
        slug = re.sub(r'-+', '-', slug)
        return slug[:max_len].rstrip('-') or 'output'

    async def run(self):
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
        chapters = await self._planner.plan(self.topic)
        job.outline = chapters
        job_store.update(job)

        await push_event(self.job_id, SSEEvent(
            event="outline_ready", data={"outline": chapters}
        ))

        if self.intervention_on_outline:
            reply = await job_store.wait_for_reply(self.job_id)
            if reply and reply.strip().lower() not in ("ok", "确认", "继续", "yes"):
                revised = self._planner.parse_outline(reply)
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
            # 搜索
            await push_event(self.job_id, SSEEvent(
                event="searching", data={"title": chapter_title}
            ))
            research = await self._search.search(chapter_title)

            # 写作
            content = await self._writer.write(
                topic=self.topic,
                outline=outline_text,
                chapter_title=chapter_title,
                research=research,
            )

            # 轻审
            await push_event(self.job_id, SSEEvent(
                event="reviewing_chapter", data={"title": chapter_title}
            ))
            chapter_review = await self._reviewer.review_chapter(
                chapter_title=chapter_title,
                content=content,
                outline=outline_text,
            )
            if not chapter_review.passed:
                content = await self._writer.write(
                    topic=self.topic,
                    outline=outline_text,
                    chapter_title=chapter_title,
                    research=research,
                    review_feedback=chapter_review.feedback,
                )

            written_chapters.append({"title": chapter_title, "content": content})
            job.chapters = written_chapters
            job_store.update(job)

            await push_event(self.job_id, SSEEvent(
                event="chapter_done",
                data={
                    "title": chapter_title,
                    "index": len(written_chapters) - 1,
                    "review": {
                        "passed": chapter_review.passed,
                        "feedback": chapter_review.feedback,
                    },
                },
            ))

            if self.intervention_on_chapter:
                await job_store.wait_for_reply(self.job_id)

        # ── Stage 3: REVIEW ────────────────────────────────────────
        job.stage = StageStatus.REVIEW
        job_store.update(job)
        await push_event(self.job_id, SSEEvent(
            event="stage_update", data={"stage": StageStatus.REVIEW}
        ))
        await push_event(self.job_id, SSEEvent(
            event="reviewing_full", data={}
        ))

        full_results = await self._reviewer.review_full(
            topic=self.topic,
            chapters=written_chapters,
        )

        for i, result in enumerate(full_results):
            if not result.passed and i < len(written_chapters):
                ch = written_chapters[i]
                new_content = await self._writer.write(
                    topic=self.topic,
                    outline=outline_text,
                    chapter_title=ch["title"],
                    research="",
                    review_feedback=result.feedback,
                )
                written_chapters[i] = {"title": ch["title"], "content": new_content}

        job.chapters = written_chapters
        job_store.update(job)

        await push_event(self.job_id, SSEEvent(
            event="review_done",
            data={
                "results": [
                    {"title": written_chapters[i]["title"], "passed": r.passed, "feedback": r.feedback}
                    for i, r in enumerate(full_results)
                ]
            },
        ))

        # ── Stage 4: EXPORT ────────────────────────────────────────
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
            event="done", data={"output_path": output_path}
        ))

    def _build_markdown(self, topic: str, chapters: list[dict]) -> str:
        lines = [f"# {topic}\n"]
        for ch in chapters:
            lines.append(f"\n## {ch['title']}\n")
            lines.append(ch["content"])
        return "\n".join(lines)
```

- [ ] **Step 4: 运行全量测试确认通过**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/ -v
# Expected: 全部通过（含新增 2 个 orchestrator 测试）
```

- [ ] **Step 5: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add backend/agent/orchestrator.py tests/test_orchestrator.py
git commit -m "feat: Orchestrator integrates ReviewAgent — light review per chapter + full review stage"
```

---

## Task 5: 前端 types + useJobStream 扩展

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/hooks/useJobStream.ts`

- [ ] **Step 1: 替换 frontend/src/types.ts**

```typescript
export type StageStatus = "plan" | "write" | "review" | "export" | "done" | "error";

export interface InterventionConfig {
  on_outline: boolean;
  on_chapter: boolean;
}

export interface ReviewResult {
  passed: boolean;
  feedback: string;
}

export interface ActivityEntry {
  id: number;
  status: "running" | "success" | "failed" | "info";
  message: string;
}

export interface JobState {
  jobId: string;
  stage: StageStatus;
  outline: string[] | null;
  chapters: { title: string; content: string }[];
  error: string | null;
}

export type SSEEventType =
  | "stage_update"
  | "outline_ready"
  | "searching"
  | "reviewing_chapter"
  | "chapter_done"
  | "reviewing_full"
  | "review_done"
  | "done"
  | "error";

export interface SSEPayload {
  event: SSEEventType;
  data: Record<string, unknown>;
}
```

- [ ] **Step 2: 更新 useJobStream.ts 中的 SSE_EVENT_TYPES 列表**

将 `frontend/src/hooks/useJobStream.ts` 中的 `SSE_EVENT_TYPES` 数组替换为：

```typescript
const SSE_EVENT_TYPES: SSEEventType[] = [
  'stage_update',
  'outline_ready',
  'searching',
  'reviewing_chapter',
  'chapter_done',
  'reviewing_full',
  'review_done',
  'done',
  'error',
]
```

- [ ] **Step 3: 运行前端类型检查**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer/frontend && npx tsc --noEmit
# Expected: 无错误（或只有现有未修改文件的错误）
```

- [ ] **Step 4: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add frontend/src/types.ts frontend/src/hooks/useJobStream.ts
git commit -m "feat: extend frontend types and SSE event list for Phase 3"
```

---

## Task 6: ActivityPanel 组件

**Files:**
- Create: `frontend/src/components/ActivityPanel.tsx`

- [ ] **Step 1: 创建 ActivityPanel.tsx**

创建 `frontend/src/components/ActivityPanel.tsx`：

```tsx
import { useEffect, useRef } from 'react'
import type { ActivityEntry } from '../types'

interface Props {
  entries: ActivityEntry[]
}

const STATUS_ICON: Record<ActivityEntry['status'], string> = {
  running: '⟳',
  success: '✓',
  failed: '✗',
  info: '→',
}

const STATUS_COLOR: Record<ActivityEntry['status'], string> = {
  running: '#2563eb',
  success: '#16a34a',
  failed: '#dc2626',
  info: '#64748b',
}

export function ActivityPanel({ entries }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  // 新条目追加时自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries.length])

  if (entries.length === 0) return null

  return (
    <div
      role="log"
      aria-label="任务进度日志"
      aria-live="polite"
      style={{
        margin: '0 0 12px',
        border: '1px solid #e2e8f0',
        borderRadius: '6px',
        background: '#f8fafc',
        maxHeight: '240px',
        overflowY: 'auto',
        padding: '12px 16px',
      }}
    >
      {entries.map((entry) => (
        <div
          key={entry.id}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            padding: '3px 0',
            fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
            fontSize: '13px',
            lineHeight: '1.5',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              color: STATUS_COLOR[entry.status],
              flexShrink: 0,
              width: '16px',
              display: 'inline-block',
              animation: entry.status === 'running'
                ? 'spin 1s linear infinite'
                : undefined,
            }}
          >
            {STATUS_ICON[entry.status]}
          </span>
          <span style={{ color: entry.status === 'failed' ? '#dc2626' : '#334155' }}>
            {entry.message}
          </span>
        </div>
      ))}
      <div ref={bottomRef} />
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
      `}</style>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add frontend/src/components/ActivityPanel.tsx
git commit -m "feat: ActivityPanel — real-time activity log with status icons"
```

---

## Task 7: 全局样式 + InputPanel + StagePanel 重设计

**Files:**
- Modify: `frontend/src/index.css`
- Modify: `frontend/src/components/InputPanel.tsx`
- Modify: `frontend/src/components/StagePanel.tsx`

- [ ] **Step 1: 更新 index.css CSS 变量**

在 `frontend/src/index.css` 的 `:root` 块中，覆盖以下变量（保留其他变量不变）：

```css
:root {
  --text: #475569;
  --text-h: #0f172a;
  --bg: #ffffff;
  --border: #e2e8f0;
  --code-bg: #f1f5f9;
  --accent: #2563eb;
  --accent-bg: rgba(37, 99, 235, 0.06);
  --accent-border: rgba(37, 99, 235, 0.3);
  --success: #16a34a;
  --danger: #dc2626;
  --muted: #94a3b8;
  --shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
  --sans: system-ui, 'Segoe UI', Roboto, sans-serif;
  --mono: 'SF Mono', 'Fira Code', 'Consolas', monospace;
}
```

在文件末尾追加：

```css
/* Focus visible — 全局键盘焦点样式 */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}

/* 卡片基础样式 */
.card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow);
  padding: 16px 20px;
  margin-bottom: 12px;
}

/* 主按钮 */
.btn-primary {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 8px 18px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}
.btn-primary:hover { background: #1d4ed8; }
.btn-primary:disabled { background: var(--muted); cursor: not-allowed; }
```

- [ ] **Step 2: 重写 InputPanel.tsx**

将 `frontend/src/components/InputPanel.tsx` 完整替换为：

```tsx
import { useState } from 'react'
import type { InterventionConfig } from '../types'

interface Props {
  onSubmit: (topic: string, intervention: InterventionConfig) => void
  disabled: boolean
}

export function InputPanel({ onSubmit, disabled }: Props) {
  const [topic, setTopic] = useState('')
  const [onOutline, setOnOutline] = useState(true)
  const [onChapter, setOnChapter] = useState(false)

  function handleSubmit() {
    if (!topic.trim()) return
    onSubmit(topic, { on_outline: onOutline, on_chapter: onChapter })
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', gap: '8px' }}>
        <label htmlFor="topic-input" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
          写作主题
        </label>
        <input
          id="topic-input"
          type="text"
          placeholder="输入写作主题，例如：RAG 检索增强生成"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          autoComplete="off"
          disabled={disabled}
          style={{
            flex: 1,
            padding: '8px 12px',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            fontSize: '14px',
            color: 'var(--text-h)',
            background: disabled ? '#f8fafc' : '#fff',
            outline: 'none',
          }}
        />
        <button
          className="btn-primary"
          onClick={handleSubmit}
          disabled={disabled || !topic.trim()}
          aria-label="开始写作"
        >
          开始写作
        </button>
      </div>
      <div style={{ display: 'flex', gap: '20px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={onOutline}
            onChange={(e) => setOnOutline(e.target.checked)}
            disabled={disabled}
          />
          大纲生成后介入
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={onChapter}
            onChange={(e) => setOnChapter(e.target.checked)}
            disabled={disabled}
          />
          每章完成后介入
        </label>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 重写 StagePanel.tsx**

将 `frontend/src/components/StagePanel.tsx` 完整替换为：

```tsx
import type { StageStatus } from '../types'

const STAGES: { key: StageStatus; label: string }[] = [
  { key: 'plan', label: '规划大纲' },
  { key: 'write', label: '撰写章节' },
  { key: 'review', label: '审稿' },
  { key: 'export', label: '导出文章' },
]

const STAGE_ORDER: StageStatus[] = ['plan', 'write', 'review', 'export', 'done']

interface Props {
  currentStage: StageStatus | null
  completedChapters: number
  totalChapters: number
}

export function StagePanel({ currentStage, completedChapters, totalChapters }: Props) {
  const currentIndex = currentStage ? STAGE_ORDER.indexOf(currentStage) : -1

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="写作进度"
      className="card"
      style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '14px 20px' }}
    >
      {STAGES.map(({ key, label }, i) => {
        const done = currentIndex > i || currentStage === 'done'
        const active = STAGE_ORDER[currentIndex] === key
        const pending = !done && !active

        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', flex: i < STAGES.length - 1 ? 1 : undefined }}>
            {/* 节点 */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
              <div
                aria-current={active ? 'step' : undefined}
                style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '13px',
                  fontWeight: 600,
                  background: done ? '#16a34a' : active ? '#2563eb' : '#f1f5f9',
                  color: done || active ? '#fff' : '#94a3b8',
                  border: active ? '2px solid #2563eb' : '2px solid transparent',
                  boxShadow: active ? '0 0 0 3px rgba(37,99,235,0.15)' : undefined,
                  transition: 'all 0.2s',
                }}
              >
                {done ? '✓' : i + 1}
              </div>
              <span style={{
                fontSize: '11px',
                fontWeight: active ? 600 : 400,
                color: done ? '#16a34a' : active ? '#2563eb' : '#94a3b8',
                whiteSpace: 'nowrap',
              }}>
                {label}
                {key === 'write' && totalChapters > 0 && (
                  <span style={{ marginLeft: '3px', opacity: 0.8 }}>
                    ({completedChapters}/{totalChapters})
                  </span>
                )}
              </span>
            </div>
            {/* 连接线 */}
            {i < STAGES.length - 1 && (
              <div style={{
                flex: 1,
                height: '2px',
                background: done ? '#16a34a' : '#e2e8f0',
                margin: '0 4px',
                marginBottom: '18px',
                transition: 'background 0.3s',
              }} />
            )}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 4: 运行前端类型检查**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer/frontend && npx tsc --noEmit
# Expected: 无新增错误
```

- [ ] **Step 5: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add frontend/src/index.css frontend/src/components/InputPanel.tsx frontend/src/components/StagePanel.tsx
git commit -m "feat: redesign InputPanel and StagePanel with tech-light theme"
```

---

## Task 8: ReviewPanel 重设计 + App.tsx 接入

**Files:**
- Modify: `frontend/src/components/ReviewPanel.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: 重写 ReviewPanel.tsx**

将 `frontend/src/components/ReviewPanel.tsx` 完整替换为：

```tsx
import { useState } from 'react'

interface Props {
  outline: string[]
  onConfirm: (reply: string) => void
}

export function ReviewPanel({ outline, onConfirm }: Props) {
  const [reply, setReply] = useState('')

  return (
    <div
      className="card"
      style={{ borderLeft: '3px solid #2563eb', paddingLeft: '17px' }}
    >
      <h3 style={{ margin: '0 0 12px', fontSize: '15px', fontWeight: 600, color: '#0f172a' }}>
        大纲已生成，请确认
      </h3>
      <ol style={{ margin: '0 0 12px', paddingLeft: '20px', fontSize: '14px', color: '#334155', lineHeight: '1.8' }}>
        {outline.map((ch, i) => (
          <li key={i}>{ch}</li>
        ))}
      </ol>
      <p style={{ fontSize: '12px', color: '#94a3b8', margin: '0 0 10px' }}>
        如需调整，在下方输入修改意见；直接点击确认则按此大纲写作。
      </p>
      <textarea
        aria-label="修改意见"
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        placeholder="可选：输入修改意见，如「把第三章改成讲实战案例」"
        style={{
          width: '100%',
          height: '72px',
          marginBottom: '10px',
          padding: '8px 10px',
          border: '1px solid #e2e8f0',
          borderRadius: '4px',
          fontSize: '13px',
          resize: 'vertical',
          boxSizing: 'border-box',
          color: '#334155',
        }}
      />
      <button
        className="btn-primary"
        onClick={() => onConfirm(reply || '确认')}
      >
        确认继续
      </button>
    </div>
  )
}
```

- [ ] **Step 2: 重写 App.tsx**

将 `frontend/src/App.tsx` 完整替换为：

```tsx
import { useState, useCallback } from 'react'
import { InputPanel } from './components/InputPanel'
import { StagePanel } from './components/StagePanel'
import { ReviewPanel } from './components/ReviewPanel'
import { ActivityPanel } from './components/ActivityPanel'
import { useJobStream } from './hooks/useJobStream'
import type { JobState, InterventionConfig, SSEEventType, ActivityEntry, ReviewResult } from './types'

const API_BASE = 'http://localhost:8000'

const INITIAL_JOB: JobState = {
  jobId: '',
  stage: 'plan',
  outline: null,
  chapters: [],
  error: null,
}

let activityIdCounter = 0

export default function App() {
  const [job, setJob] = useState<JobState | null>(null)
  const [awaitingReview, setAwaitingReview] = useState(false)
  const [completedChapters, setCompletedChapters] = useState(0)
  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([])

  function addActivity(status: ActivityEntry['status'], message: string) {
    setActivityLog((prev) => [...prev, { id: ++activityIdCounter, status, message }])
  }

  const handleEvent = useCallback((type: SSEEventType, data: Record<string, unknown>) => {
    let reviewUpdate: boolean | null = null

    setJob((prev) => {
      if (!prev) return prev
      switch (type) {
        case 'stage_update':
          return { ...prev, stage: data.stage as JobState['stage'] }
        case 'outline_ready':
          reviewUpdate = true
          return { ...prev, outline: data.outline as string[] }
        case 'done':
          reviewUpdate = false
          return { ...prev, stage: 'done' }
        case 'error':
          return { ...prev, stage: 'error', error: data.message as string }
        default:
          return prev
      }
    })

    // 活动日志
    switch (type) {
      case 'searching':
        addActivity('running', `搜索中：${data.title as string}`)
        break
      case 'reviewing_chapter':
        addActivity('running', `轻审中：${data.title as string}`)
        break
      case 'chapter_done': {
        const review = data.review as ReviewResult | undefined
        setCompletedChapters((n) => n + 1)
        if (review && !review.passed) {
          addActivity('failed', `轻审未通过：${data.title as string} → 已重写`)
        } else {
          addActivity('success', `章节完成：${data.title as string}`)
        }
        break
      }
      case 'reviewing_full':
        addActivity('running', '全文重审中...')
        break
      case 'review_done': {
        const results = data.results as Array<{ title: string; passed: boolean; feedback: string }>
        const failedCount = results.filter((r) => !r.passed).length
        if (failedCount === 0) {
          addActivity('success', '全文审稿通过')
        } else {
          addActivity('info', `全文审稿：${failedCount} 章重写完成`)
        }
        break
      }
      case 'done':
        addActivity('success', '文章已生成，保存到 output/ 目录')
        break
      case 'error':
        addActivity('failed', `错误：${data.message as string}`)
        break
    }

    if (reviewUpdate !== null) setAwaitingReview(reviewUpdate)
  }, [])

  useJobStream(job?.jobId ?? null, handleEvent)

  async function handleSubmit(topic: string, intervention: InterventionConfig) {
    const res = await fetch(`${API_BASE}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, intervention }),
    })
    const { job_id } = await res.json()
    setJob({ ...INITIAL_JOB, jobId: job_id })
    setCompletedChapters(0)
    setAwaitingReview(false)
    setActivityLog([])
  }

  async function handleConfirm(reply: string) {
    if (!job) return
    setAwaitingReview(false)
    await fetch(`${API_BASE}/jobs/${job.jobId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: reply }),
    })
  }

  return (
    <div style={{ maxWidth: '760px', margin: '0 auto', padding: '32px 16px', fontFamily: 'var(--sans)' }}>
      <h1 style={{ fontFamily: 'var(--mono)', fontSize: '22px', fontWeight: 700, color: '#0f172a', marginBottom: '24px', letterSpacing: '-0.5px' }}>
        vibe-writer
      </h1>

      <InputPanel
        onSubmit={handleSubmit}
        disabled={!!job && job.stage !== 'done' && job.stage !== 'error'}
      />

      {job && (
        <StagePanel
          currentStage={job.stage}
          completedChapters={completedChapters}
          totalChapters={job.outline?.length ?? 0}
        />
      )}

      {awaitingReview && job?.outline && (
        <ReviewPanel outline={job.outline} onConfirm={handleConfirm} />
      )}

      <ActivityPanel entries={activityLog} />

      {job?.stage === 'done' && (
        <div
          role="status"
          style={{ padding: '12px 16px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '6px', fontSize: '14px', color: '#15803d' }}
        >
          ✓ 文章已生成并保存到 <code style={{ background: '#dcfce7', padding: '1px 5px', borderRadius: '3px' }}>output/</code> 目录
        </div>
      )}

      {job?.error && (
        <div
          role="alert"
          style={{ padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px', fontSize: '14px', color: '#dc2626' }}
        >
          错误：{job.error}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: 运行前端类型检查**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer/frontend && npx tsc --noEmit
# Expected: 无错误
```

- [ ] **Step 4: 启动前端确认页面正常渲染**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer/frontend && npm run dev
# 打开 http://localhost:5173 确认：
# - 标题为 monospace 字体 "vibe-writer"
# - InputPanel 有输入框 + 按钮 + 两个 checkbox
# - 无 JS 错误
```

- [ ] **Step 5: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add frontend/src/components/ReviewPanel.tsx frontend/src/App.tsx
git commit -m "feat: redesign ReviewPanel, App.tsx integrates ActivityPanel and Phase 3 SSE events"
```

---

## Self-Review Checklist

### Spec Coverage

| Spec 要求 | Task |
|-----------|------|
| ReviewAgent.review_chapter (连贯性 + 完整度) | Task 1 |
| ReviewAgent.review_full (全文质量) | Task 1 |
| PASSED/FAILED 文本格式解析 | Task 1 |
| 解析失败时默认 PASSED（容错） | Task 1 |
| WriterAgent.write() review_feedback 参数 | Task 2 |
| StageStatus.REVIEW 新增 | Task 3 |
| Orchestrator 轻审每章 + 不通过重写一次 | Task 4 |
| Orchestrator 重审阶段 + 不通过章节各重写一次 | Task 4 |
| reviewing_chapter / review_done SSE 事件 | Task 4 |
| chapter_done 携带 review 字段 | Task 4 |
| 前端 types 扩展（ReviewResult、ActivityEntry、新 SSE 类型） | Task 5 |
| useJobStream 新增事件监听 | Task 5 |
| ActivityPanel 实时日志（搜索/轻审/重审/完成） | Task 6 |
| 浅色科技感 CSS 变量 | Task 7 |
| InputPanel 无障碍修复（aria-label、type、label 包裹） | Task 7 |
| StagePanel 新增 review 阶段 + 步进条样式 + aria-live | Task 7 |
| ReviewPanel 无障碍修复（textarea aria-label） + 样式 | Task 8 |
| App.tsx 处理新 SSE 事件 + ActivityPanel 接入 | Task 8 |
| 错误提示 role="alert" | Task 8 |

### 类型一致性

- `ReviewResult.passed: bool` (Python) ↔ `ReviewResult.passed: boolean` (TypeScript) ✓
- `review_feedback: str = ""` (WriterAgent) ↔ `review_feedback=result.feedback` (Orchestrator) ✓
- `StageStatus.REVIEW = "review"` (Python) ↔ `"review"` in StageStatus union (TypeScript) ✓
- `chapter_done.data.review` 字段：`{passed: bool, feedback: str}` (Python) ↔ `ReviewResult` (TypeScript) ✓
- `ActivityEntry.status` 枚举值：`"running" | "success" | "failed" | "info"` 在 ActivityPanel 和 App.tsx 中一致 ✓
