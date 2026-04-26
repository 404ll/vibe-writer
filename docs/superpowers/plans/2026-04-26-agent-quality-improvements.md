# Agent 质量改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复三个 Agent 质量问题：Reviewer 解析脆弱、OpinionAgent 串行调用、重写无收敛保证。

**Architecture:** 在 `BaseAgent` 新增 `_call_llm_json()`；修改 prompts 要求 JSON 输出；`ReviewAgent` 和 `OpinionAgent` 改用新方法；`Orchestrator` 的重写逻辑加二次审。三个改动互相独立，按 A → B → C 顺序实现，每个改动完成后单独提交。

**Tech Stack:** Python asyncio, pytest-asyncio, unittest.mock, json

---

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `backend/agent/base.py` | 新增 `_call_llm_json()` 方法 |
| `backend/agent/prompts.py` | 修改 `CHAPTER_REVIEW_SYSTEM`、`FULL_REVIEW_SYSTEM`；合并 `OPINION_SYSTEM`/`OPINION_USER`；删除 `OPINION_SEARCH_SYSTEM`/`OPINION_SEARCH_USER` |
| `backend/agent/reviewer.py` | 改用 `_call_llm_json`，删除 `_parse_chapter_result` 和 `_parse_full_results` |
| `backend/agent/opinion.py` | `generate()` 改为单次 `_call_llm_json` 调用 |
| `backend/agent/orchestrator.py` | `_write_chapter` 加二次轻审；`_run_pipeline` 全文重审加二次验证 |
| `tests/test_reviewer.py` | mock 返回值改为 JSON 字符串 |
| `tests/test_orchestrator.py` | 更新二次审相关测试 |

---

## Task 1：BaseAgent 新增 `_call_llm_json()`

**Files:**
- Modify: `backend/agent/base.py`

- [ ] **Step 1: 写失败测试**

在 `tests/` 下新建 `tests/test_base_agent.py`：

```python
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from backend.agent.base import BaseAgent


@pytest.mark.asyncio
async def test_call_llm_json_returns_parsed_dict():
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text='{"passed": true, "feedback": ""}')]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = BaseAgent()
        result = await agent._call_llm_json("system", "user")

    assert result == {"passed": True, "feedback": ""}


@pytest.mark.asyncio
async def test_call_llm_json_returns_empty_dict_on_invalid_json():
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="这不是JSON")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = BaseAgent()
        result = await agent._call_llm_json("system", "user")

    assert result == {}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
python -m pytest tests/test_base_agent.py -v
```

预期：`AttributeError: 'BaseAgent' object has no attribute '_call_llm_json'`

- [ ] **Step 3: 实现 `_call_llm_json`**

编辑 `backend/agent/base.py`，在 `_stream_llm` 之后添加：

```python
import json
import logging

log = logging.getLogger("vibe.base")

# 在 class BaseAgent 内，_stream_llm 方法之后添加：

    async def _call_llm_json(self, system: str, user: str, max_tokens: int = 512) -> dict:
        """调用 LLM 并解析 JSON 响应。解析失败时返回空 dict 并 log warning。"""
        raw = await self._call_llm(system, user, max_tokens)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            log.warning("JSON parse failed, raw=%r", raw[:200])
            return {}
```

注意：`import json` 和 `import logging` / `log = ...` 加到文件顶部，不要重复已有的 import。

- [ ] **Step 4: 运行测试确认通过**

```bash
python -m pytest tests/test_base_agent.py -v
```

预期：2 个测试全部 PASS

- [ ] **Step 5: 提交**

```bash
git add backend/agent/base.py tests/test_base_agent.py
git commit -m "feat: add _call_llm_json to BaseAgent"
```

---

## Task 2：Reviewer 改用 JSON 输出（改动 A）

**Files:**
- Modify: `backend/agent/prompts.py`
- Modify: `backend/agent/reviewer.py`
- Modify: `tests/test_reviewer.py`

- [ ] **Step 1: 更新 `prompts.py` 中的 Review prompts**

将 `CHAPTER_REVIEW_SYSTEM` 替换为：

```python
CHAPTER_REVIEW_SYSTEM = """你是一位技术博客审稿人。请审阅给定的章节内容，检查以下两点：
1. 连贯性：与大纲中其他章节是否衔接自然，不重复也不跳跃
2. 完整度：章节标题是否被充分展开（内容不少于 200 字，有实质性讲解）

以 JSON 格式输出，不要输出任何其他内容：
{"passed": true/false, "feedback": "不通过时的理由和建议，通过时为空字符串"}

示例（通过）：{"passed": true, "feedback": ""}
示例（不通过）：{"passed": false, "feedback": "内容过短，建议补充实际案例"}"""
```

将 `FULL_REVIEW_SYSTEM` 替换为：

```python
FULL_REVIEW_SYSTEM = """你是一位技术博客审稿人。请审阅完整文章的每一章，检查：
1. 整体可读性：行文是否流畅，逻辑是否清晰
2. 技术准确性：技术描述是否正确
3. 章节间连贯性：各章是否自然衔接

以 JSON 格式输出，results 数组长度必须与章节数量完全一致，不要输出任何其他内容：
{"results": [{"passed": true/false, "feedback": "不通过时的理由和建议，通过时为空字符串"}, ...]}

示例（2章，章节一通过，章节二不通过）：
{"results": [{"passed": true, "feedback": ""}, {"passed": false, "feedback": "逻辑跳跃，建议加过渡段"}]}"""
```

- [ ] **Step 2: 更新 `reviewer.py`**

将整个文件替换为：

```python
import logging
from dataclasses import dataclass, field
from backend.agent.base import BaseAgent
from backend.agent.prompts import (
    CHAPTER_REVIEW_SYSTEM, CHAPTER_REVIEW_USER,
    FULL_REVIEW_SYSTEM, FULL_REVIEW_USER,
)

log = logging.getLogger("vibe.reviewer")


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
        data = await self._call_llm_json(
            CHAPTER_REVIEW_SYSTEM,
            CHAPTER_REVIEW_USER.format(
                outline=outline,
                chapter_title=chapter_title,
                content=content,
            ),
            max_tokens=512,
        )
        if not data:
            log.warning("review_chapter: JSON parse failed, defaulting to PASSED  chapter=%r", chapter_title)
            return ReviewResult(passed=True, feedback="")
        return ReviewResult(
            passed=bool(data.get("passed", True)),
            feedback=data.get("feedback", ""),
        )

    async def review_full(
        self,
        topic: str,
        chapters: list[dict],
    ) -> list[ReviewResult]:
        """重审：全文整体质量。返回与 chapters 等长的 ReviewResult 列表。"""
        full_text = "\n\n".join(
            f"## {ch['title']}\n{ch['content']}" for ch in chapters
        )
        data = await self._call_llm_json(
            FULL_REVIEW_SYSTEM,
            FULL_REVIEW_USER.format(topic=topic, full_text=full_text),
            max_tokens=1024,
        )
        if not data or "results" not in data:
            log.warning("review_full: JSON parse failed, defaulting all to PASSED  topic=%r", topic)
            return [ReviewResult(passed=True, feedback="") for _ in chapters]

        results = [
            ReviewResult(
                passed=bool(r.get("passed", True)),
                feedback=r.get("feedback", ""),
            )
            for r in data["results"]
        ]
        # 数量不匹配时用 PASSED 填充（容错）
        while len(results) < len(chapters):
            results.append(ReviewResult(passed=True, feedback=""))
        return results[:len(chapters)]
```

- [ ] **Step 3: 更新 `tests/test_reviewer.py`**

将文件替换为（mock 返回值改为 JSON 字符串）：

```python
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from backend.agent.reviewer import ReviewAgent, ReviewResult


@pytest.mark.asyncio
async def test_review_chapter_passed():
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text='{"passed": true, "feedback": ""}')]
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
    mock_message.content = [MagicMock(text='{"passed": false, "feedback": "内容过短，建议补充实际案例"}')]
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
    mock_message.content = [MagicMock(text='{"results": [{"passed": true, "feedback": ""}, {"passed": false, "feedback": "逻辑跳跃，建议加过渡段"}]}')]
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

- [ ] **Step 4: 运行测试确认通过**

```bash
python -m pytest tests/test_reviewer.py tests/test_base_agent.py -v
```

预期：所有测试 PASS

- [ ] **Step 5: 提交**

```bash
git add backend/agent/prompts.py backend/agent/reviewer.py tests/test_reviewer.py
git commit -m "feat: reviewer uses JSON output, replace regex parsing"
```

---

## Task 3：OpinionAgent 合并为单次调用（改动 B）

**Files:**
- Modify: `backend/agent/prompts.py`
- Modify: `backend/agent/opinion.py`

- [ ] **Step 1: 写失败测试**

新建 `tests/test_opinion.py`：

```python
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from backend.agent.opinion import OpinionAgent


@pytest.mark.asyncio
async def test_generate_returns_opinions_and_queries():
    """generate() 一次调用返回论点文本和搜索词列表"""
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text='''{
        "opinions": ["AI 会取代初级程序员", "工具链复杂度是真正门槛"],
        "search_queries": ["AI 取代程序员 2024", "编程工具链复杂度趋势"]
    }''')]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = OpinionAgent()
        opinions_text, search_queries = await agent.generate(
            topic="AI 与程序员",
            outline="1. 现状\n2. 影响",
            chapter_title="AI 会取代程序员吗",
        )

    assert "AI 会取代初级程序员" in opinions_text
    assert "工具链复杂度是真正门槛" in opinions_text
    assert search_queries == ["AI 取代程序员 2024", "编程工具链复杂度趋势"]
    # 只调用了一次 LLM
    assert mock_client.messages.create.call_count == 1


@pytest.mark.asyncio
async def test_generate_fallback_on_invalid_json():
    """JSON 解析失败时返回空论点和空搜索词，不抛异常"""
    mock_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="无法解析的输出")]
    mock_client.messages.create = AsyncMock(return_value=mock_message)

    with patch("backend.agent.base.anthropic.AsyncAnthropic", return_value=mock_client):
        agent = OpinionAgent()
        opinions_text, search_queries = await agent.generate(
            topic="测试",
            outline="1. 章节一",
            chapter_title="章节一",
        )

    assert opinions_text == ""
    assert search_queries == []
```

- [ ] **Step 2: 运行测试确认失败**

```bash
python -m pytest tests/test_opinion.py -v
```

预期：`test_generate_returns_opinions_and_queries` 失败，因为目前 `generate()` 调用两次 LLM（`call_count == 1` 断言失败）

- [ ] **Step 3: 更新 `prompts.py` 中的 Opinion prompts**

删除 `OPINION_SEARCH_SYSTEM` 和 `OPINION_SEARCH_USER`，将 `OPINION_SYSTEM` 和 `OPINION_USER` 替换为：

```python
OPINION_SYSTEM = """你是一位有独立见解的专栏作者。用户给你一篇文章的主题、完整大纲和某个章节标题，你需要为这个章节提出 2-3 个核心论点，并为每个论点生成一个搜索词。

要求：
- 论点必须是你自己的判断或洞察，不是对现象的描述
- 每个论点要有一定的反直觉性或争议性，不能是"AI 很强大"这类废话
- 论点之间不重复，角度各异
- 每个论点不超过 50 字
- 搜索词简洁（5-15 字），聚焦于能找到支撑证据、数据或反例的角度

以 JSON 格式输出，不要输出任何其他内容：
{"opinions": ["论点1", "论点2", "论点3"], "search_queries": ["搜索词1", "搜索词2", "搜索词3"]}"""

OPINION_USER = """文章主题：{topic}

完整大纲：
{outline}

当前章节：{chapter_title}

请为这个章节提出 2-3 个核心论点，并为每个论点生成一个搜索词。"""
```

- [ ] **Step 4: 更新 `opinion.py`**

将整个文件替换为：

```python
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
```

- [ ] **Step 5: 运行测试确认通过**

```bash
python -m pytest tests/test_opinion.py -v
```

预期：2 个测试全部 PASS

- [ ] **Step 6: 运行全量测试确认无回归**

```bash
python -m pytest tests/ -v --ignore=tests/test_articles_router.py --ignore=tests/test_database.py -k "not export_saves_article"
```

预期：所有测试 PASS

- [ ] **Step 7: 提交**

```bash
git add backend/agent/prompts.py backend/agent/opinion.py tests/test_opinion.py
git commit -m "feat: merge opinion+search into single LLM call"
```

---

## Task 4：重写收敛保证（改动 C）

**Files:**
- Modify: `backend/agent/orchestrator.py`
- Modify: `tests/test_orchestrator.py`

- [ ] **Step 1: 写新的失败测试**

在 `tests/test_orchestrator.py` 末尾追加两个测试：

```python
@pytest.mark.asyncio
async def test_write_chapter_second_review_after_rewrite(monkeypatch):
    """轻审不通过 → 重写 → 二次审（共调用 review_chapter 2 次）"""
    events = []

    async def fake_push(job_id, event):
        events.append(event)

    monkeypatch.setattr("backend.agent.orchestrator.push_event", fake_push)

    mock_planner = MagicMock()
    mock_planner.plan = AsyncMock(return_value=["章节一"])

    mock_search = MagicMock()
    mock_search.search = AsyncMock(return_value="")

    mock_writer = MagicMock()
    mock_writer.write_stream = AsyncMock(return_value=iter([]))

    async def fake_write_stream(**kwargs):
        yield "内容"

    mock_writer.write_stream = fake_write_stream

    from backend.agent.reviewer import ReviewResult
    mock_reviewer = MagicMock()
    # 第1次轻审 FAILED，第2次轻审 PASSED
    mock_reviewer.review_chapter = AsyncMock(side_effect=[
        ReviewResult(passed=False, feedback="内容过短"),
        ReviewResult(passed=True, feedback=""),
    ])
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

    # review_chapter 被调用 2 次（初审 + 二次审）
    assert mock_reviewer.review_chapter.call_count == 2
    event_types = [e.event for e in events]
    assert "done" in event_types


@pytest.mark.asyncio
async def test_full_review_second_pass_after_rewrite(monkeypatch):
    """全文重审不通过 → 重写 → 二次全文审（review_full 共调用 2 次）"""
    events = []

    async def fake_push(job_id, event):
        events.append(event)

    monkeypatch.setattr("backend.agent.orchestrator.push_event", fake_push)

    mock_planner = MagicMock()
    mock_planner.plan = AsyncMock(return_value=["章节一"])

    mock_search = MagicMock()
    mock_search.search = AsyncMock(return_value="")

    async def fake_write_stream(**kwargs):
        yield "内容"

    mock_writer = MagicMock()
    mock_writer.write_stream = fake_write_stream
    mock_writer.write = AsyncMock(return_value="重写内容")

    from backend.agent.reviewer import ReviewResult
    mock_reviewer = MagicMock()
    mock_reviewer.review_chapter = AsyncMock(return_value=ReviewResult(passed=True, feedback=""))
    # 第1次全文审 FAILED，第2次全文审 PASSED
    mock_reviewer.review_full = AsyncMock(side_effect=[
        [ReviewResult(passed=False, feedback="逻辑不清")],
        [ReviewResult(passed=True, feedback="")],
    ])

    store = JobStore()
    job = store.create_job("测试主题")

    with patch("backend.agent.orchestrator.job_store", store), \
         patch("backend.agent.orchestrator.PlannerAgent", return_value=mock_planner), \
         patch("backend.agent.orchestrator.SearchAgent", return_value=mock_search), \
         patch("backend.agent.orchestrator.WriterAgent", return_value=mock_writer), \
         patch("backend.agent.orchestrator.ReviewAgent", return_value=mock_reviewer):
        orch = Orchestrator(job.id, "测试主题", intervention_on_outline=False)
        await orch.run()

    # review_full 被调用 2 次
    assert mock_reviewer.review_full.call_count == 2
    event_types = [e.event for e in events]
    assert "done" in event_types
```

- [ ] **Step 2: 运行测试确认失败**

```bash
python -m pytest tests/test_orchestrator.py::test_write_chapter_second_review_after_rewrite tests/test_orchestrator.py::test_full_review_second_pass_after_rewrite -v
```

预期：两个测试失败（`review_chapter.call_count` 为 1 而非 2，`review_full.call_count` 为 1 而非 2）

- [ ] **Step 3: 修改 `_write_chapter` 加二次轻审**

在 `orchestrator.py` 的 `_write_chapter` 方法中，找到重写逻辑（当前约第 136-155 行）：

```python
if not review.passed:
    log.info("[%s] rewrite      chapter=%r  feedback=%r",
             self.job_id[:8], chapter_title, review.feedback[:80])
    # 重写时也用流式（同样推送 token）
    rewrite_parts: list[str] = []
    async for token in self._writer.write_stream(
        topic=self.topic,
        outline=outline_text,
        chapter_title=chapter_title,
        research=research,
        opinions=opinions_text,
        review_feedback=review.feedback,
        chapter_words=chapter_words,
    ):
        rewrite_parts.append(token)
        await push_event(self.job_id, SSEEvent(
            event="writing_chapter",
            data={"title": chapter_title, "token": token},
        ))
    content = "".join(rewrite_parts)
```

替换为：

```python
if not review.passed:
    log.info("[%s] rewrite      chapter=%r  feedback=%r",
             self.job_id[:8], chapter_title, review.feedback[:80])
    # 重写时也用流式（同样推送 token）
    rewrite_parts: list[str] = []
    async for token in self._writer.write_stream(
        topic=self.topic,
        outline=outline_text,
        chapter_title=chapter_title,
        research=research,
        opinions=opinions_text,
        review_feedback=review.feedback,
        chapter_words=chapter_words,
    ):
        rewrite_parts.append(token)
        await push_event(self.job_id, SSEEvent(
            event="writing_chapter",
            data={"title": chapter_title, "token": token},
        ))
    content = "".join(rewrite_parts)

    # 二次审：重写后再审一次，不通过则 log warning 并接受当前内容
    await push_event(self.job_id, SSEEvent(
        event="reviewing_chapter", data={"title": chapter_title}
    ))
    review2 = await self._reviewer.review_chapter(
        chapter_title=chapter_title,
        content=content,
        outline=outline_text,
    )
    if not review2.passed:
        log.warning("[%s] rewrite still failed  chapter=%r  feedback=%r",
                    self.job_id[:8], chapter_title, review2.feedback[:80])
```

- [ ] **Step 4: 修改 `_run_pipeline` 加全文重审二次验证**

在 `orchestrator.py` 的 `_run_pipeline` 方法中，找到全文重审后的重写逻辑（当前约第 305-316 行）：

```python
rewrite_tasks = [
    _rewrite(i, written_chapters[i], result.feedback)
    for i, result in enumerate(full_results)
    if not result.passed
]
if rewrite_tasks:
    rewrite_results = await asyncio.gather(*rewrite_tasks)
    for i, new_content in rewrite_results:
        ch = written_chapters[i]
        written_chapters[i] = {"title": ch["title"], "content": new_content, "index": i, "research": ch.get("research", "")}

job.chapters = written_chapters
job_store.update(job)
```

替换为：

```python
rewrite_tasks = [
    _rewrite(i, written_chapters[i], result.feedback)
    for i, result in enumerate(full_results)
    if not result.passed
]
if rewrite_tasks:
    rewrite_results = await asyncio.gather(*rewrite_tasks)
    for i, new_content in rewrite_results:
        ch = written_chapters[i]
        written_chapters[i] = {"title": ch["title"], "content": new_content, "index": i, "research": ch.get("research", ""), "opinions": ch.get("opinions", "")}

    # 二次全文审：重写后再审一次
    full_results2 = await self._reviewer.review_full(
        topic=self.topic,
        chapters=written_chapters,
    )
    rewrite_tasks2 = [
        _rewrite(i, written_chapters[i], result.feedback)
        for i, result in enumerate(full_results2)
        if not result.passed
    ]
    if rewrite_tasks2:
        rewrite_results2 = await asyncio.gather(*rewrite_tasks2)
        for i, new_content in rewrite_results2:
            ch = written_chapters[i]
            written_chapters[i] = {"title": ch["title"], "content": new_content, "index": i, "research": ch.get("research", ""), "opinions": ch.get("opinions", "")}
            log.warning("[%s] full_review still failed after rewrite  chapter=%r", self.job_id[:8], ch["title"])

job.chapters = written_chapters
job_store.update(job)
```

- [ ] **Step 5: 运行新测试确认通过**

```bash
python -m pytest tests/test_orchestrator.py::test_write_chapter_second_review_after_rewrite tests/test_orchestrator.py::test_full_review_second_pass_after_rewrite -v
```

预期：2 个测试 PASS

- [ ] **Step 6: 运行全量测试确认无回归**

```bash
python -m pytest tests/ -v --ignore=tests/test_articles_router.py --ignore=tests/test_database.py -k "not export_saves_article"
```

预期：所有测试 PASS

- [ ] **Step 7: 提交**

```bash
git add backend/agent/orchestrator.py tests/test_orchestrator.py
git commit -m "feat: add second review pass after rewrite for convergence"
```

---

## Task 5：最终验证

- [ ] **Step 1: 运行全量测试（含 DB 测试）**

```bash
python -m pytest tests/ -v
```

预期：所有测试 PASS

- [ ] **Step 2: 检查 import 清理**

确认 `reviewer.py` 中已删除 `import re`（不再需要）：

```bash
grep "import re" backend/agent/reviewer.py
```

预期：无输出

- [ ] **Step 3: 最终提交（如有遗漏文件）**

```bash
git status
```

如有未提交文件，补充提交。
