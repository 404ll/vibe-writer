# Phase 5b 设计文档：章节自动重试

**日期：** 2026-04-24
**状态：** 待实现

---

## 目标

`asyncio.gather` 中某章节写作失败时，自动重试最多 3 次（指数退避），而不是让整个 job 直接进入 ERROR 状态。

---

## 决策记录

- **重试封装在 `_write_chapter` 内部**，对 gather 层透明。理由：符合"单章完整流程"的封装原则，测试最简单。
- **最多 3 次，指数退避**：第 1 次失败等 1s，第 2 次等 2s，第 3 次等 4s。
- **3 次全部失败**：`_write_chapter` 不抛出异常，而是返回 `{"title": ..., "content": "", "index": i, "error": "..."}`，orchestrator 检测到 error 字段后推送 SSE error 事件并终止 job。
- **不重试的情况**：`review_chapter` / `review_full` 失败不重试（这些是 LLM 判断，失败概率极低；重试逻辑只针对写作/搜索的网络/API 错误）。

---

## 一、后端变更

### 1.1 `backend/agent/orchestrator.py`

**`_write_chapter` 加重试循环：**

```python
async def _write_chapter(
    self,
    chapter_title: str,
    outline_text: str,
    index: int,
) -> dict:
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            if attempt > 0:
                await asyncio.sleep(2 ** (attempt - 1))  # 1s, 2s
                await push_event(self.job_id, SSEEvent(
                    event="searching",
                    data={"title": chapter_title, "retry": attempt},
                ))
            else:
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
            return {"title": chapter_title, "content": content, "index": index, "research": research}

        except Exception as e:
            last_error = e

    # 3 次全部失败，返回 error dict（不抛出）
    return {"title": chapter_title, "content": "", "index": index, "research": "", "error": str(last_error)}
```

**gather 后检测 error 字段：**

```python
results = await asyncio.gather(*tasks, return_exceptions=True)

# return_exceptions=True 捕获意外异常（理论上不会触发，因为 _write_chapter 内部已处理）
unexpected = [(i, r) for i, r in enumerate(results) if isinstance(r, Exception)]
if unexpected:
    msg = "; ".join(f"章节{i+1}: {r}" for i, r in unexpected)
    job.error = f"章节写作异常: {msg}"
    job.stage = StageStatus.ERROR
    job_store.update(job)
    await push_event(self.job_id, SSEEvent(event="error", data={"message": job.error}))
    return

# 检测 3 次重试全部失败的章节
failed = [r for r in results if r.get("error")]
if failed:
    msg = "; ".join(f"{r['title']}: {r['error']}" for r in failed)
    job.error = f"章节写作失败: {msg}"
    job.stage = StageStatus.ERROR
    job_store.update(job)
    await push_event(self.job_id, SSEEvent(event="error", data={"message": job.error}))
    return

written_chapters = sorted(results, key=lambda r: r["index"])
```

---

## 二、测试变更

### `tests/test_orchestrator.py`

新增两个测试：

**`test_write_chapter_retries_on_failure`** — writer 前两次抛出异常，第三次成功，最终章节正常完成：

```python
@pytest.mark.asyncio
async def test_write_chapter_retries_on_failure(monkeypatch):
    """writer 前两次失败，第三次成功 → job 正常完成"""
    # writer.write 前两次抛 RuntimeError，第三次返回内容
    call_count = 0
    async def flaky_write(**kwargs):
        nonlocal call_count
        call_count += 1
        if call_count <= 2:
            raise RuntimeError("API timeout")
        return "章节内容"
    ...
    assert mock_writer.write.call_count == 3  # 2 次失败 + 1 次成功
    assert "done" in event_types
```

**`test_write_chapter_fails_after_max_retries`** — writer 三次全部失败，job 进入 ERROR：

```python
@pytest.mark.asyncio
async def test_write_chapter_fails_after_max_retries(monkeypatch):
    """writer 三次全部失败 → job 进入 ERROR 状态"""
    mock_writer.write = AsyncMock(side_effect=RuntimeError("API timeout"))
    ...
    assert "error" in event_types
    final_job = store.get(job.id)
    assert final_job.stage == StageStatus.ERROR
```

---

## 三、文件变更清单

| 文件 | 变更 |
|------|------|
| `backend/agent/orchestrator.py` | `_write_chapter` 加重试循环；gather 后检测 error 字段 |
| `tests/test_orchestrator.py` | 新增 2 个重试测试 |

---

## 四、不在本次范围内

- 手动重试（前端按钮触发单章重跑）
- `review_chapter` / `review_full` 的重试
- 重试次数可配置
