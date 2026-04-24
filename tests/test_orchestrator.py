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

    mock_writer = MagicMock()
    mock_writer.write = AsyncMock(return_value="章节正文内容")

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

    mock_planner.plan.assert_called_once_with("测试主题")
    assert mock_search.search.call_count == 2
    assert mock_writer.write.call_count == 2

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

    mock_writer = MagicMock()
    mock_writer.write = AsyncMock(return_value="无参考资料的章节内容")

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

    mock_writer.write.assert_called_once()
    call_kwargs = mock_writer.write.call_args.kwargs
    assert call_kwargs["research"] == ""

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
