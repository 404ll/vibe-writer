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

    mock_planner = MagicMock()
    mock_planner.plan = AsyncMock(return_value=["章节一", "章节二"])

    mock_search = MagicMock()
    mock_search.search = AsyncMock(return_value="- 参考要点")

    mock_opinion = MagicMock()
    mock_opinion.generate = AsyncMock(return_value=("- 测试论点", ["测试搜索词"]))

    mock_writer = MagicMock()
    mock_writer.write = AsyncMock(return_value="章节正文内容")
    async def fake_write_stream(**kwargs):
        yield "章节内容"
    mock_writer.write_stream = fake_write_stream

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
         patch("backend.agent.orchestrator.OpinionAgent", return_value=mock_opinion), \
         patch("backend.agent.orchestrator.SearchAgent", return_value=mock_search), \
         patch("backend.agent.orchestrator.WriterAgent", return_value=mock_writer), \
         patch("backend.agent.orchestrator.ReviewAgent", return_value=mock_reviewer):
        orch = Orchestrator(job.id, "测试主题", intervention_on_outline=False)
        await orch.run()

    mock_planner.plan.assert_called_once_with("测试主题")
    assert mock_search.search.call_count == 2

    event_types = [e.event for e in events]
    assert "outline_ready" in event_types
    assert event_types.count("searching") == 2  # 2 chapters → 2 searching events
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
    mock_search.search = AsyncMock(return_value="")

    mock_opinion = MagicMock()
    mock_opinion.generate = AsyncMock(return_value=("- 测试论点", ["测试搜索词"]))

    mock_writer = MagicMock()
    mock_writer.write = AsyncMock(return_value="无参考资料的章节内容")
    async def fake_write_stream(**kwargs):
        yield "章节内容"
    mock_writer.write_stream = fake_write_stream

    from backend.agent.reviewer import ReviewResult
    mock_reviewer = MagicMock()
    mock_reviewer.review_chapter = AsyncMock(return_value=ReviewResult(passed=True, feedback=""))
    mock_reviewer.review_full = AsyncMock(return_value=[ReviewResult(passed=True, feedback="")])

    store = JobStore()
    job = store.create_job("测试主题")

    with patch("backend.agent.orchestrator.job_store", store), \
         patch("backend.agent.orchestrator.PlannerAgent", return_value=mock_planner), \
         patch("backend.agent.orchestrator.OpinionAgent", return_value=mock_opinion), \
         patch("backend.agent.orchestrator.SearchAgent", return_value=mock_search), \
         patch("backend.agent.orchestrator.WriterAgent", return_value=mock_writer), \
         patch("backend.agent.orchestrator.ReviewAgent", return_value=mock_reviewer):
        orch = Orchestrator(job.id, "测试主题", intervention_on_outline=False)
        await orch.run()

    event_types = [e.event for e in events]
    assert "done" in event_types


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

    mock_opinion = MagicMock()
    mock_opinion.generate = AsyncMock(return_value=("- 测试论点", ["测试搜索词"]))

    write_stream_call_count = 0
    async def fake_write_stream(**kwargs):
        nonlocal write_stream_call_count
        write_stream_call_count += 1
        yield "章节内容"

    mock_writer = MagicMock()
    mock_writer.write = AsyncMock(return_value="章节内容")
    mock_writer.write_stream = fake_write_stream

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
         patch("backend.agent.orchestrator.OpinionAgent", return_value=mock_opinion), \
         patch("backend.agent.orchestrator.SearchAgent", return_value=mock_search), \
         patch("backend.agent.orchestrator.WriterAgent", return_value=mock_writer), \
         patch("backend.agent.orchestrator.ReviewAgent", return_value=mock_reviewer):
        orch = Orchestrator(job.id, "测试主题", intervention_on_outline=False)
        await orch.run()

    # 轻审不通过 → write_stream 被调用 2 次（原写 + 重写）
    assert write_stream_call_count == 2

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

    mock_opinion = MagicMock()
    mock_opinion.generate = AsyncMock(return_value=("- 测试论点", ["测试搜索词"]))

    mock_writer = MagicMock()
    mock_writer.write = AsyncMock(return_value="章节内容")
    async def fake_write_stream(**kwargs):
        yield "章节内容"
    mock_writer.write_stream = fake_write_stream

    from backend.agent.reviewer import ReviewResult
    mock_reviewer = MagicMock()
    # 轻审全部通过
    mock_reviewer.review_chapter = AsyncMock(
        return_value=ReviewResult(passed=True, feedback="")
    )
    # 第一次重审：章节一通过，章节二不通过；第二次重审全部通过
    mock_reviewer.review_full = AsyncMock(side_effect=[
        [ReviewResult(passed=True, feedback=""), ReviewResult(passed=False, feedback="逻辑跳跃")],
        [ReviewResult(passed=True, feedback=""), ReviewResult(passed=True, feedback="")],
    ])

    store = JobStore()
    job = store.create_job("测试主题")

    with patch("backend.agent.orchestrator.job_store", store), \
         patch("backend.agent.orchestrator.PlannerAgent", return_value=mock_planner), \
         patch("backend.agent.orchestrator.OpinionAgent", return_value=mock_opinion), \
         patch("backend.agent.orchestrator.SearchAgent", return_value=mock_search), \
         patch("backend.agent.orchestrator.WriterAgent", return_value=mock_writer), \
         patch("backend.agent.orchestrator.ReviewAgent", return_value=mock_reviewer):
        orch = Orchestrator(job.id, "测试主题", intervention_on_outline=False)
        await orch.run()

    # 重审不通过的 1 章用 write（非流式）重写
    assert mock_writer.write.call_count == 1

    event_types = [e.event for e in events]
    assert "review_done" in event_types
    assert "done" in event_types


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

    mock_opinion = MagicMock()
    mock_opinion.generate = AsyncMock(return_value=("- 测试论点", ["测试搜索词"]))

    mock_writer = MagicMock()
    mock_writer.write = AsyncMock(return_value="章节内容")
    async def fake_write_stream(**kwargs):
        yield "章节内容"
    mock_writer.write_stream = fake_write_stream

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
         patch("backend.agent.orchestrator.OpinionAgent", return_value=mock_opinion), \
         patch("backend.agent.orchestrator.SearchAgent", return_value=mock_search), \
         patch("backend.agent.orchestrator.WriterAgent", return_value=mock_writer), \
         patch("backend.agent.orchestrator.ReviewAgent", return_value=mock_reviewer):
        orch = Orchestrator(job.id, "测试主题", intervention_on_outline=False)
        await orch.run()

    # 最终 written_chapters 按大纲顺序：章节一在前
    final_job = store.get(job.id)
    assert final_job.chapters[0]["title"] == "章节一"
    assert final_job.chapters[1]["title"] == "章节二"

    event_types = [e.event for e in events]
    assert event_types.count("chapter_done") == 2
    assert "done" in event_types


@pytest.mark.asyncio
async def test_write_chapter_retries_on_failure(monkeypatch):
    """writer 前两次抛异常，第三次成功 → job 正常完成"""
    events = []

    async def fake_push(job_id, event):
        events.append(event)

    monkeypatch.setattr("backend.agent.orchestrator.push_event", fake_push)
    monkeypatch.setattr("backend.agent.orchestrator.asyncio.sleep", AsyncMock())

    mock_planner = MagicMock()
    mock_planner.plan = AsyncMock(return_value=["章节一"])

    mock_search = MagicMock()
    mock_search.search = AsyncMock(return_value="")

    mock_opinion = MagicMock()
    mock_opinion.generate = AsyncMock(return_value=("- 测试论点", ["测试搜索词"]))

    call_count = 0
    async def flaky_write_stream(**kwargs):
        nonlocal call_count
        call_count += 1
        if call_count <= 2:
            raise RuntimeError("API timeout")
        yield "章节内容"

    mock_writer = MagicMock()
    mock_writer.write_stream = flaky_write_stream

    from backend.agent.reviewer import ReviewResult
    mock_reviewer = MagicMock()
    mock_reviewer.review_chapter = AsyncMock(return_value=ReviewResult(passed=True, feedback=""))
    mock_reviewer.review_full = AsyncMock(return_value=[ReviewResult(passed=True, feedback="")])

    store = JobStore()
    job = store.create_job("测试主题")

    with patch("backend.agent.orchestrator.job_store", store), \
         patch("backend.agent.orchestrator.PlannerAgent", return_value=mock_planner), \
         patch("backend.agent.orchestrator.OpinionAgent", return_value=mock_opinion), \
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
    monkeypatch.setattr("backend.agent.orchestrator.asyncio.sleep", AsyncMock())

    mock_planner = MagicMock()
    mock_planner.plan = AsyncMock(return_value=["章节一"])

    mock_search = MagicMock()
    mock_search.search = AsyncMock(return_value="")

    mock_opinion = MagicMock()
    mock_opinion.generate = AsyncMock(return_value=("- 测试论点", ["测试搜索词"]))

    async def always_fail_stream(**kwargs):
        raise RuntimeError("API timeout")
        yield  # 让 Python 识别为异步生成器

    mock_writer = MagicMock()
    mock_writer.write_stream = always_fail_stream

    from backend.agent.reviewer import ReviewResult
    mock_reviewer = MagicMock()
    mock_reviewer.review_chapter = AsyncMock(return_value=ReviewResult(passed=True, feedback=""))
    mock_reviewer.review_full = AsyncMock(return_value=[ReviewResult(passed=True, feedback="")])

    store = JobStore()
    job = store.create_job("测试主题")

    with patch("backend.agent.orchestrator.job_store", store), \
         patch("backend.agent.orchestrator.PlannerAgent", return_value=mock_planner), \
         patch("backend.agent.orchestrator.OpinionAgent", return_value=mock_opinion), \
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


@pytest.mark.asyncio
async def test_export_saves_article_to_db(monkeypatch):
    """EXPORT 阶段完成后，article 写入数据库"""
    from backend.database import init_db
    await init_db()

    events = []

    async def fake_push(job_id, event):
        events.append(event)

    monkeypatch.setattr("backend.agent.orchestrator.push_event", fake_push)

    mock_planner = MagicMock()
    mock_planner.plan = AsyncMock(return_value=["章节一"])
    mock_planner.parse_outline = MagicMock(return_value=[])

    mock_search = MagicMock()
    mock_search.search = AsyncMock(return_value="")

    mock_writer = MagicMock()
    mock_writer.write = AsyncMock(return_value="章节内容")

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

    from backend.database import AsyncSessionLocal
    from backend.models_db import Article
    from sqlalchemy import select
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(Article).where(Article.job_id == job.id))
        article = result.scalar_one_or_none()

    assert article is not None
    assert article.topic == "测试主题"
    assert article.word_count > 0


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

    mock_opinion = MagicMock()
    mock_opinion.generate = AsyncMock(return_value=("观点内容", ["query1"]))

    async def fake_write_stream(**kwargs):
        yield "内容"

    mock_writer = MagicMock()
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
         patch("backend.agent.orchestrator.OpinionAgent", return_value=mock_opinion), \
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

    mock_opinion = MagicMock()
    mock_opinion.generate = AsyncMock(return_value=("观点内容", ["query1"]))

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
         patch("backend.agent.orchestrator.OpinionAgent", return_value=mock_opinion), \
         patch("backend.agent.orchestrator.SearchAgent", return_value=mock_search), \
         patch("backend.agent.orchestrator.WriterAgent", return_value=mock_writer), \
         patch("backend.agent.orchestrator.ReviewAgent", return_value=mock_reviewer):
        orch = Orchestrator(job.id, "测试主题", intervention_on_outline=False)
        await orch.run()

    # review_full 被调用 2 次
    assert mock_reviewer.review_full.call_count == 2
    event_types = [e.event for e in events]
    assert "done" in event_types
