# vibe-writer Phase 4a 设计文档：章节并行写作

**日期：** 2026-04-24  
**状态：** 待实现

---

## 目标

将 WRITE 阶段从串行（每章依次执行）改为并行（所有章节同时执行），同时移除 `intervention_on_chapter` 功能。

**预期效果：** N 章文章的写作时间从 `N × t` 降至约 `t`（单章耗时）。

---

## 决策记录

- **并行方案：** `asyncio.gather`（不加 Semaphore）— 3-6 章并发量对 LLM API 无压力，实现最简单
- **SSE 事件顺序：** 保持交错顺序 — 实时反映各章进度，体现并行感
- **移除 `intervention_on_chapter`：** 并行时无法保证章节完成顺序，该功能与并行不兼容，直接删除

---

## 一、后端变更

### 1.1 `backend/agent/orchestrator.py`

**新增私有方法 `_write_chapter`：**

```python
async def _write_chapter(
    self,
    chapter_title: str,
    outline_text: str,
    index: int,
) -> dict:
    """单章完整流程：搜索 → 写作 → 轻审（不通过重写一次）。返回 {title, content, index}。"""
    await push_event(self.job_id, SSEEvent(event="searching", data={"title": chapter_title}))
    research = await self._search.search(chapter_title)

    content = await self._writer.write(
        topic=self.topic,
        outline=outline_text,
        chapter_title=chapter_title,
        research=research,
    )

    await push_event(self.job_id, SSEEvent(event="reviewing_chapter", data={"title": chapter_title}))
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
```

**WRITE 阶段改为 `asyncio.gather`：**

```python
tasks = [
    self._write_chapter(title, outline_text, i)
    for i, title in enumerate(chapters)
]
results = await asyncio.gather(*tasks)
# 按原始大纲顺序排列（gather 结果顺序与任务顺序一致，sort 作为保险）
written_chapters = sorted(results, key=lambda r: r["index"])
```

**移除 `intervention_on_chapter`：**
- `__init__` 删除 `intervention_on_chapter` 参数及 `self.intervention_on_chapter`
- WRITE 阶段删除章节后的 `wait_for_reply` 调用

### 1.2 `backend/models.py`

`InterventionConfig` 删除 `on_chapter` 字段：

```python
class InterventionConfig(BaseModel):
    on_outline: bool = True
```

### 1.3 `tests/test_orchestrator.py`

- 所有测试中 `Orchestrator(...)` 调用删除 `intervention_on_chapter` 参数
- 新增测试 `test_orchestrator_writes_chapters_in_parallel`：验证 2 章时 `gather` 被正确调用（mock 两章均完成，验证 `written_chapters` 长度和顺序）

---

## 二、前端变更

### 2.1 `frontend/src/types.ts`

`InterventionConfig` 删除 `on_chapter`：

```typescript
export interface InterventionConfig {
  on_outline: boolean;
}
```

### 2.2 `frontend/src/components/InputPanel.tsx`

删除"每章完成后介入" checkbox 及其相关 state（`onChapter`、`setOnChapter`）。

`handleSubmit` 中 `onSubmit` 调用改为：
```typescript
onSubmit(topic, { on_outline: onOutline })
```

### 2.3 `frontend/src/App.tsx`

`handleSubmit` 中 `body` 字段无需改动（`on_chapter` 字段已从类型中删除，TypeScript 会报错提示）。

---

## 三、文件变更清单

| 文件 | 变更 |
|------|------|
| `backend/agent/orchestrator.py` | 新增 `_write_chapter`，WRITE 阶段改 `gather`，删除 `intervention_on_chapter` |
| `backend/models.py` | `InterventionConfig` 删除 `on_chapter` |
| `tests/test_orchestrator.py` | 更新现有测试，新增并行测试 |
| `frontend/src/types.ts` | `InterventionConfig` 删除 `on_chapter` |
| `frontend/src/components/InputPanel.tsx` | 删除"每章后介入" checkbox |

---

## 四、不在本次范围内

- Semaphore 限速（当前章节数 3-6，无需限速）
- 断点续写（Phase 5 单独处理）
- 章节重试机制（Phase 5 单独处理）
