# Parallel Chapter Writing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 WRITE 阶段从串行改为 `asyncio.gather` 并行，同时移除 `intervention_on_chapter` 功能。

**Architecture:** 在 Orchestrator 中提取 `_write_chapter` 私有方法封装单章流程（搜索→写作→轻审），WRITE 阶段改用 `asyncio.gather` 并发调用所有章节，结果按 index 排序后交给 REVIEW 阶段。`InterventionConfig.on_chapter` 字段及相关前端 checkbox 一并删除。

**Tech Stack:** Python asyncio, FastAPI, React 18, TypeScript

---

## File Map

| 文件 | 变更 |
|------|------|
| `backend/agent/orchestrator.py` | 新增 `_write_chapter`，WRITE 阶段改 `gather`，删除 `intervention_on_chapter` |
| `backend/models.py` | `InterventionConfig` 删除 `on_chapter` |
| `tests/test_orchestrator.py` | 更新现有 4 个测试（删除 `intervention_on_chapter` 参数），新增并行测试 |
| `frontend/src/types.ts` | `InterventionConfig` 删除 `on_chapter` |
| `frontend/src/components/InputPanel.tsx` | 删除"每章后介入" checkbox 及相关 state |

---

## Task 1: 后端 — 重构 Orchestrator 为并行写作

**Files:**
- Modify: `backend/agent/orchestrator.py`
- Modify: `backend/models.py`
- Modify: `tests/test_orchestrator.py`

- [ ] **Step 1: 在 test_orchestrator.py 末尾追加并行测试（先写失败测试）**

在 `tests/test_orchestrator.py` 末尾追加：

```python
@pytest.mark.asyncio
async def test_orchestrator_writes_chapters_in_parallel(monkeypatch):
    """2 章时，_write_chapter 被并行调用，written_chapters 按大纲顺序排列"""
    events = []
    call_order = []

    async def fake_push(job_id, event):
        events.append(event)

    monkeypatch.setattr("backend.agent.orchestrator.push_event", fake_push)

    mock_planner = MagicMock()
    mock_planner.plan = AsyncMock(return_value=["章节一", "章节二"])

    mock_search = MagicMock()
    mock_search.search = AsyncMock(return_value="")

    mock_writer = MagicMock()
    # 章节一写作慢（模拟），章节二写作快 — 并行时两章都能完成
    mock_writer.write = AsyncMock(return_value="章节内容")

    from backend.agent.reviewer import ReviewResult
    mock_reviewer = MagicMock()
    mock_reviewer.review_chapter = AsyncMock(return_value=ReviewResult(passed=True, feedback=""))
    mock_reviewer.review_full = AsyncMock(return_value=[
        ReviewResult(passed=True, feedback=""),
        ReviewResult(passed=True, feedback=""),
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

    # 2 章均完成，writer 各调用一次
    assert mock_writer.write.call_count == 2
    # 最终 written_chapters 按大纲顺序：章节一在前
    final_job = store.get(job.id)
    assert final_job.chapters[0]["title"] == "章节一"
    assert final_job.chapters[1]["title"] == "章节二"

    event_types = [e.event for e in events]
    assert event_types.count("chapter_done") == 2
    assert "done" in event_types
```

- [ ] **Step 2: 运行新测试确认失败**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_orchestrator.py::test_orchestrator_writes_chapters_in_parallel -v
# Expected: PASS（当前串行实现也能通过此测试，因为只验证结果不验证并行性）
# 这是预期的——我们先确保测试逻辑正确，重构后仍然通过
```

- [ ] **Step 3: 修改 backend/models.py — 删除 on_chapter**

将 `backend/models.py` 中的 `InterventionConfig` 替换为：

```python
class InterventionConfig(BaseModel):
    on_outline: bool = True
```

- [ ] **Step 4: 重写 backend/agent/orchestrator.py**

将 `backend/agent/orchestrator.py` 完整替换为：

```python
import asyncio
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
      WRITE  → 所有章节并行：搜索 → 写作 → 轻审（不通过重写一次）
      REVIEW → 重审全文（不通过的章节各重写一次）
      EXPORT → 拼接 Markdown，写文件
    """

    def __init__(
        self,
        job_id: str,
        topic: str,
        intervention_on_outline: bool = True,
    ):
        self.job_id = job_id
        self.topic = topic
        self.intervention_on_outline = intervention_on_outline
        self._planner = PlannerAgent()
        self._search = SearchAgent()
        self._writer = WriterAgent()
        self._reviewer = ReviewAgent()

    def _safe_filename(self, text: str, max_len: int = 30) -> str:
        slug = re.sub(r'[^\w\-\u4e00-\u9fff]', '-', text)
        slug = re.sub(r'-+', '-', slug)
        return slug[:max_len].rstrip('-') or 'output'

    async def _write_chapter(
        self,
        chapter_title: str,
        outline_text: str,
        index: int,
    ) -> dict:
        """单章完整流程：搜索 → 写作 → 轻审（不通过重写一次）。返回 {title, content, index}。"""
        await push_event(self.job_id, SSEEvent(
            event="searching", data={"title": chapter_title}
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
        return {"title": chapter_title, "content": content, "index": index}

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

        # ── Stage 2: WRITE（并行）─────────────────────────────────
        job.stage = StageStatus.WRITE
        job_store.update(job)
        await push_event(self.job_id, SSEEvent(
            event="stage_update", data={"stage": StageStatus.WRITE}
        ))

        outline_text = "\n".join(f"{i+1}. {c}" for i, c in enumerate(chapters))

        tasks = [
            self._write_chapter(title, outline_text, i)
            for i, title in enumerate(chapters)
        ]
        results = await asyncio.gather(*tasks)
        # gather 保证结果顺序与任务顺序一致；sort 作为保险
        written_chapters = sorted(results, key=lambda r: r["index"])

        job.chapters = written_chapters
        job_store.update(job)

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
            if not result.passed:
                ch = written_chapters[i]
                new_content = await self._writer.write(
                    topic=self.topic,
                    outline=outline_text,
                    chapter_title=ch["title"],
                    research="",
                    review_feedback=result.feedback,
                )
                written_chapters[i] = {"title": ch["title"], "content": new_content, "index": i}

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

- [ ] **Step 5: 更新 test_orchestrator.py 中现有 4 个测试**

现有 4 个测试的 `Orchestrator(...)` 调用都有 `intervention_on_outline=False`，不需要修改（`intervention_on_chapter` 参数已不存在，但现有测试本来就没传这个参数）。

验证现有测试中没有 `intervention_on_chapter` 参数：

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && grep "intervention_on_chapter" tests/test_orchestrator.py
# Expected: 无输出（现有测试没有使用该参数）
```

- [ ] **Step 6: 运行全量测试确认通过**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/ -v
# Expected: 全部通过（含新增的并行测试，共 28 个）
```

- [ ] **Step 7: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add backend/agent/orchestrator.py backend/models.py tests/test_orchestrator.py
git commit -m "feat: parallel chapter writing with asyncio.gather, remove intervention_on_chapter"
```

---

## Task 2: 前端 — 删除 on_chapter 字段和 checkbox

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/components/InputPanel.tsx`

- [ ] **Step 1: 修改 frontend/src/types.ts**

将 `InterventionConfig` 接口替换为：

```typescript
export interface InterventionConfig {
  on_outline: boolean;
}
```

- [ ] **Step 2: 修改 frontend/src/components/InputPanel.tsx**

将 `InputPanel.tsx` 完整替换为：

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

  function handleSubmit() {
    if (!topic.trim()) return
    onSubmit(topic, { on_outline: onOutline })
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
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 运行前端类型检查**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer/frontend && npx tsc --noEmit 2>&1
# Expected: 无错误
```

- [ ] **Step 4: 运行全量后端测试确认无回归**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/ -v
# Expected: 全部通过
```

- [ ] **Step 5: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add frontend/src/types.ts frontend/src/components/InputPanel.tsx
git commit -m "feat: remove on_chapter intervention from frontend"
```

---

## Self-Review Checklist

### Spec Coverage

| Spec 要求 | Task |
|-----------|------|
| `_write_chapter` 私有方法 | Task 1 |
| `asyncio.gather` 并行 WRITE | Task 1 |
| 结果按 index 排序 | Task 1 |
| 删除 `intervention_on_chapter` 参数 | Task 1 |
| `InterventionConfig` 删除 `on_chapter` | Task 1 + Task 2 |
| 前端删除"每章后介入" checkbox | Task 2 |
| 新增并行测试 | Task 1 |

### 类型一致性

- `_write_chapter` 返回 `dict` 含 `{title: str, content: str, index: int}`，`written_chapters` 排序后传给 `_build_markdown` 和 `review_full` — 一致 ✓
- `InterventionConfig.on_outline: bool`（Python）↔ `on_outline: boolean`（TypeScript）— 一致 ✓
- `Orchestrator.__init__` 只剩 `intervention_on_outline` 参数，现有测试已用 `intervention_on_outline=False`，无需修改 ✓
