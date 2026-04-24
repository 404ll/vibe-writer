# Phase 5b: Chapter Auto-Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `_write_chapter` 内部最多重试 3 次（指数退避），全部失败时 job 进入 ERROR 状态。

**Architecture:** 重试逻辑完全封装在 `_write_chapter` 内，对 `asyncio.gather` 层透明。`_write_chapter` 内部 `for attempt in range(3)` 捕获异常，成功时正常返回，3 次全部失败时返回含 `error` 字段的 dict；orchestrator 在 gather 后检测 `error` 字段决定是否终止 job。

**Tech Stack:** Python asyncio, pytest-asyncio

---

## File Map

| 文件 | 变更 |
|------|------|
| `backend/agent/orchestrator.py` | `_write_chapter` 加重试循环；gather 后检测 error 字段 |
| `tests/test_orchestrator.py` | 新增 2 个重试测试 |

---

## Task 1: 重试逻辑 + 测试

**Files:**
- Modify: `backend/agent/orchestrator.py`
- Modify: `tests/test_orchestrator.py`

- [ ] **Step 1: 在 tests/test_orchestrator.py 末尾追加两个失败测试**

```python
@pytest.mark.asyncio
async def test_write_chapter_retries_on_failure(monkeypatch):
    """writer 前两次抛异常，第三次成功 → job 正常完成"""
    events = []

    async def fake_push(job_id, event):
        events.append(event)

    monkeypatch.setattr("backend.agent.orchestrator.push_event", fake_push)

    mock_planner = MagicMock()
    mock_planner.plan = AsyncMock(return_value=["章节一"])

    mock_search = MagicMock()
    mock_search.search = AsyncMock(return_value="")

    call_count = 0
    async def flaky_write(**kwargs):
        nonlocal call_count
        call_count += 1
        if call_count <= 2:
            raise RuntimeError("API timeout")
        return "章节内容"

    mock_writer = MagicMock()
    mock_writer.write = flaky_write

    from backend.agent.reviewer import ReviewResult
    mock_reviewer = MagicMock()
    mock_reviewer.review_chapter = AsyncMock(return_value=ReviewResult(passed=True, feedback=""))
    mock_reviewer.review_full = AsyncMock(return_value=[ReviewResult(passed=True, feedback="")])

    store = JobStore()
    job = store.create_job("测试主题")

    with patch("backend.agent.orchestrator.job_store", store), \
         patch("backend.agent.orchestrator.PlannerAgent", return_value=mock_planner), \
         patch("backend.agent.orchestrator.SearchAgent", return_value=mock_search), \
         patch("backend.agent.orchestrator.WriterAgent", return_value=mock_writer), \
         patch("backend.agent.orchestrator.ReviewAgent", return_value=mock_reviewer):
        orch = Orchestrator(job.id, "测试主题", intervention_on_outline=False)
        await orch.run()

    assert call_count == 3  # 2 次失败 + 1 次成功
    event_types = [e.event for e in events]
    assert "done" in event_types
    assert "error" not in event_types


@pytest.mark.asyncio
async def test_write_chapter_fails_after_max_retries(monkeypatch):
    """writer 三次全部失败 → job 进入 ERROR 状态"""
    events = []

    async def fake_push(job_id, event):
        events.append(event)

    monkeypatch.setattr("backend.agent.orchestrator.push_event", fake_push)

    mock_planner = MagicMock()
    mock_planner.plan = AsyncMock(return_value=["章节一"])

    mock_search = MagicMock()
    mock_search.search = AsyncMock(return_value="")

    mock_writer = MagicMock()
    mock_writer.write = AsyncMock(side_effect=RuntimeError("API timeout"))

    from backend.agent.reviewer import ReviewResult
    mock_reviewer = MagicMock()
    mock_reviewer.review_chapter = AsyncMock(return_value=ReviewResult(passed=True, feedback=""))
    mock_reviewer.review_full = AsyncMock(return_value=[ReviewResult(passed=True, feedback="")])

    store = JobStore()
    job = store.create_job("测试主题")

    with patch("backend.agent.orchestrator.job_store", store), \
         patch("backend.agent.orchestrator.PlannerAgent", return_value=mock_planner), \
         patch("backend.agent.orchestrator.SearchAgent", return_value=mock_search), \
         patch("backend.agent.orchestrator.WriterAgent", return_value=mock_writer), \
         patch("backend.agent.orchestrator.ReviewAgent", return_value=mock_reviewer):
        orch = Orchestrator(job.id, "测试主题", intervention_on_outline=False)
        await orch.run()

    event_types = [e.event for e in events]
    assert "error" in event_types
    assert "done" not in event_types
    final_job = store.get(job.id)
    from backend.models import StageStatus
    assert final_job.stage == StageStatus.ERROR
```

- [ ] **Step 2: 运行新测试确认失败**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_orchestrator.py::test_write_chapter_retries_on_failure tests/test_orchestrator.py::test_write_chapter_fails_after_max_retries -v
```
Expected: FAIL（当前 `_write_chapter` 无重试逻辑）

- [ ] **Step 3: 修改 backend/agent/orchestrator.py — 替换 _write_chapter 方法**

将 `_write_chapter` 方法（第 43-87 行）完整替换为：

```python
    async def _write_chapter(
        self,
        chapter_title: str,
        outline_text: str,
        index: int,
    ) -> dict:
        """单章完整流程：搜索 → 写作 → 轻审（不通过重写一次）。
        失败时最多重试 3 次（指数退避：1s, 2s）。
        3 次全部失败时返回含 error 字段的 dict，不抛出异常。
        """
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                if attempt > 0:
                    await asyncio.sleep(2 ** (attempt - 1))  # 1s, 2s

                await push_event(self.job_id, SSEEvent(
                    event="searching",
                    data={"title": chapter_title, **({"retry": attempt} if attempt > 0 else {})},
                ))
                research = await self._search.search(chapter_title)

                content = await self._writer.write(
                    topic=self.topic,
                    outline=outline_text,
                    chapter_title=chapter_title,
                    research=research,
                )

                await push_event(self.job_id, SSEEvent(
                    event="reviewing_chapter", data={"title": chapter_title}
                ))
                review = await self._reviewer.review_chapter(
                    chapter_title=chapter_title,
                    content=content,
                    outline=outline_text,
                )
                if not review.passed:
                    content = await self._writer.write(
                        topic=self.topic,
                        outline=outline_text,
                        chapter_title=chapter_title,
                        research=research,
                        review_feedback=review.feedback,
                    )

                await push_event(self.job_id, SSEEvent(
                    event="chapter_done",
                    data={
                        "title": chapter_title,
                        "index": index,
                        "review": {"passed": review.passed, "feedback": review.feedback},
                    },
                ))
                return {"title": chapter_title, "content": content, "index": index, "research": research}

            except Exception as e:
                last_error = e

        # 3 次全部失败
        return {"title": chapter_title, "content": "", "index": index, "research": "", "error": str(last_error)}
```

同时，将 gather 后的错误检测部分（第 130-143 行）替换为：

```python
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # 意外异常（理论上不触发，_write_chapter 内部已捕获）
        unexpected = [(i, r) for i, r in enumerate(results) if isinstance(r, Exception)]
        if unexpected:
            error_msgs = "; ".join(f"章节{i+1}: {r}" for i, r in unexpected)
            job.error = f"章节写作异常: {error_msgs}"
            job.stage = StageStatus.ERROR
            job_store.update(job)
            await push_event(self.job_id, SSEEvent(event="error", data={"message": job.error}))
            return

        # 3 次重试全部失败的章节
        failed = [r for r in results if r.get("error")]
        if failed:
            msg = "; ".join(f"{r['title']}: {r['error']}" for r in failed)
            job.error = f"章节写作失败: {msg}"
            job.stage = StageStatus.ERROR
            job_store.update(job)
            await push_event(self.job_id, SSEEvent(event="error", data={"message": job.error}))
            return

        # gather 保证结果顺序与任务顺序一致；sort 作为保险
        written_chapters = sorted(results, key=lambda r: r["index"])
```

- [ ] **Step 4: 运行新测试确认通过**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_orchestrator.py::test_write_chapter_retries_on_failure tests/test_orchestrator.py::test_write_chapter_fails_after_max_retries -v
```
Expected: 2 passed

- [ ] **Step 5: 运行全量测试确认无回归**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/ -v 2>&1 | tail -5
```
Expected: 全部通过（32 或更多，取决于 5a 是否已实现）

- [ ] **Step 6: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add backend/agent/orchestrator.py tests/test_orchestrator.py
git commit -m "feat: _write_chapter auto-retry up to 3 times with exponential backoff"
```

---

## Self-Review Checklist

| Spec 要求 | Task |
|-----------|------|
| `_write_chapter` 内部重试，最多 3 次 | Task 1 Step 3 |
| 指数退避：1s, 2s | Task 1 Step 3 |
| 成功时正常返回 dict | Task 1 Step 3 |
| 3 次全部失败返回 `error` 字段 dict | Task 1 Step 3 |
| gather 后检测 `error` 字段，终止 job | Task 1 Step 3 |
| 测试：前两次失败第三次成功 → done | Task 1 Step 1 |
| 测试：三次全部失败 → ERROR | Task 1 Step 1 |
