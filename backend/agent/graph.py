"""
LangGraph 图定义：用节点 + 条件边替代 Orchestrator 的流水线。

节点只做业务逻辑，返回想修改的 state 字段。
控制流全部在条件边里。
基础设施（SSE 推送）暂时保留在节点内，阶段 4 再抽离。
"""
import asyncio
import logging
import os
import re
from typing import Optional, Callable, Awaitable
from langgraph.graph import StateGraph, START, END

from backend.models import WriterState, ChapterState, SSEEvent, StageStatus
from backend.agent.planner import PlannerAgent
from backend.agent.opinion import OpinionAgent
from backend.agent.search import SearchAgent
from backend.agent.writer import WriterAgent
from backend.agent.reviewer import ReviewAgent

log = logging.getLogger("vibe.graph")

PushEventFn = Callable[[str, SSEEvent], Awaitable[None]]
WaitForReplyFn = Callable[[str], Awaitable[str]]


# ── Agent 工厂 ────────────────────────────────────────────────

def _make_agents(style: str, search_fn) -> dict:
    return {
        "planner": PlannerAgent(),
        "opinion": OpinionAgent(),
        "writer": WriterAgent(style=style, search_fn=search_fn),
        "reviewer": ReviewAgent(),
    }


# ── 节点函数 ──────────────────────────────────────────────────

async def plan_node(
    state: WriterState,
    agents: dict,
    job_id: str,
    push_event: PushEventFn,
    wait_for_reply: Optional[WaitForReplyFn] = None,
) -> dict:
    """生成大纲，若开启 human-in-the-loop 则挂起等待用户确认"""
    await push_event(job_id, SSEEvent(event="stage_update", data={"stage": StageStatus.PLAN}))
    chapters = await agents["planner"].plan(state["topic"])
    await push_event(job_id, SSEEvent(event="outline_ready", data={"outline": chapters}))

    if wait_for_reply:
        log.info("[%s] waiting for outline confirmation", job_id[:8])
        await wait_for_reply(job_id)
        log.info("[%s] outline confirmed", job_id[:8])

    log.info("[%s] plan done  chapters=%d", job_id[:8], len(chapters))
    return {
        "outline": chapters,
        "chapters": [
            ChapterState(
                title=title,
                content="",
                review_passed=False,
                review_feedback="",
                rewrite_count=0,
            )
            for title in chapters
        ],
    }


async def write_node(state: WriterState, agents: dict, job_id: str, push_event: PushEventFn) -> dict:
    """并行写作所有未完成或 review 未通过的章节"""
    await push_event(job_id, SSEEvent(event="stage_update", data={"stage": StageStatus.WRITE}))

    outline_text = "\n".join(f"{i+1}. {c}" for i, c in enumerate(state["outline"]))
    chapter_words = (
        round(state["target_words"] / len(state["outline"]))
        if state["target_words"] else None
    )

    async def write_one(ch: ChapterState) -> ChapterState:
        # 已写完且通过 review 的章节跳过
        if ch["content"] != "" and ch["review_passed"]:
            return ch

        await push_event(job_id, SSEEvent(event="generating_opinions", data={"title": ch["title"]}))
        opinions_text, search_queries = await agents["opinion"].generate(
            topic=state["topic"],
            outline=outline_text,
            chapter_title=ch["title"],
        )
        await push_event(job_id, SSEEvent(event="opinions_ready", data={"title": ch["title"]}))

        # 包装 search_fn：在真正执行搜索前推送 searching 事件
        base_search_fn = agents["writer"]._search_fn
        async def _search_with_event(query: str) -> str:
            await push_event(job_id, SSEEvent(event="searching", data={"title": ch["title"], "query": query}))
            return await base_search_fn(query)

        chapter_writer = WriterAgent(
            style=agents["writer"]._style_instruction,
            search_fn=_search_with_event if base_search_fn else None,
        )

        async def _write_content(feedback: str = "") -> str:
            """写一次章节，返回完整内容字符串。"""
            parts: list[str] = []
            async for token in chapter_writer.write_stream(
                topic=state["topic"],
                outline=outline_text,
                chapter_title=ch["title"],
                opinions=opinions_text,
                search_hints=search_queries,
                chapter_words=chapter_words,
                review_feedback=feedback,
            ):
                parts.append(token)
                await push_event(job_id, SSEEvent(
                    event="writing_chapter",
                    data={"title": ch["title"], "token": token},
                ))
            return "".join(parts)

        # 第一次写作
        content = await _write_content(feedback=ch["review_feedback"])

        # 轻审：检查连贯性和完整度
        await push_event(job_id, SSEEvent(event="reviewing_chapter", data={"title": ch["title"]}))
        light_review = await agents["reviewer"].review_chapter(
            chapter_title=ch["title"],
            content=content,
            outline=outline_text,
        )
        log.info("[%s] light review  title=%r  passed=%s", job_id[:8], ch["title"], light_review.passed)

        if not light_review.passed:
            # 轻审不通过：带着 feedback 重写一次，重写后直接接受（不再审）
            log.info("[%s] rewriting chapter  title=%r", job_id[:8], ch["title"])
            content = await _write_content(feedback=light_review.feedback)

        await push_event(job_id, SSEEvent(
            event="chapter_done",
            data={
                "title": ch["title"],
                "review": {"passed": light_review.passed, "feedback": light_review.feedback},
            },
        ))
        log.info("[%s] chapter done  title=%r", job_id[:8], ch["title"])
        return ChapterState(
            title=ch["title"],
            content=content,
            review_passed=False,          # 留给全文重审判断
            review_feedback=light_review.feedback if not light_review.passed else "",
            rewrite_count=ch["rewrite_count"] + (0 if light_review.passed else 1),
        )

    updated = list(await asyncio.gather(*[write_one(ch) for ch in state["chapters"]]))
    return {"chapters": updated}


async def review_node(state: WriterState, agents: dict, job_id: str, push_event: PushEventFn) -> dict:
    """全文审稿"""
    await push_event(job_id, SSEEvent(event="stage_update", data={"stage": StageStatus.REVIEW}))
    await push_event(job_id, SSEEvent(event="reviewing_full", data={}))

    full_results = await agents["reviewer"].review_full(
        topic=state["topic"],
        chapters=state["chapters"],
    )

    chapters = list(state["chapters"])
    for i, result in enumerate(full_results):
        ch = chapters[i]
        chapters[i] = ChapterState(
            title=ch["title"],
            content=ch["content"],
            review_passed=result.passed,
            review_feedback=result.feedback,
            rewrite_count=ch["rewrite_count"] + (0 if result.passed else 1),
        )

    failed = sum(1 for r in full_results if not r.passed)
    log.info("[%s] review done  failed=%d/%d", job_id[:8], failed, len(full_results))

    await push_event(job_id, SSEEvent(
        event="review_done",
        data={
            "results": [
                {"title": chapters[i]["title"], "passed": r.passed, "feedback": r.feedback}
                for i, r in enumerate(full_results)
            ]
        },
    ))

    return {
        "chapters": chapters,
        "rewrite_count": state["rewrite_count"] + 1,
    }


async def export_node(state: WriterState, job_id: str, push_event: PushEventFn) -> dict:
    """拼接并保存最终文章"""
    await push_event(job_id, SSEEvent(event="stage_update", data={"stage": StageStatus.EXPORT}))

    lines = [f"# {state['topic']}\n"]
    for ch in state["chapters"]:
        lines.append(f"\n## {ch['title']}\n{ch['content']}")
    markdown = "\n".join(lines)

    slug = re.sub(r'[^\w\-\u4e00-\u9fff]', '-', state["topic"])[:30].rstrip('-') or 'output'
    output_path = f"output/{slug}.md"
    os.makedirs("output", exist_ok=True)
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(
        None,
        lambda: open(output_path, "w", encoding="utf-8").write(markdown),
    )

    log.info("[%s] export done  path=%r", job_id[:8], output_path)
    await push_event(job_id, SSEEvent(event="done", data={"output_path": output_path}))
    return {"final_content": markdown}


# ── 条件边 ────────────────────────────────────────────────────

def should_rewrite(state: WriterState) -> str:
    """
    review 节点之后的唯一决策点。
    所有关于"要不要重写"的逻辑集中在这里。
    """
    failed = [ch for ch in state["chapters"] if not ch["review_passed"]]
    if not failed:
        return "export"
    if state["rewrite_count"] >= 2:
        log.warning("review failed after %d rounds, accepting current content", state["rewrite_count"])
        return "export"
    return "write"


# ── 组装图 ────────────────────────────────────────────────────

def build_graph(
    job_id: str,
    style: str,
    target_words: Optional[int],
    push_event: PushEventFn,
    checkpointer=None,
    wait_for_reply: Optional[WaitForReplyFn] = None,
):
    """
    构建并编译 LangGraph 图。
    每次任务创建时调用一次。

    为什么用闭包注入 agents/job_id/push_event？
    LangGraph 节点签名只接收 state，但节点需要访问 agent 实例和 job_id。
    闭包让节点携带这些上下文，同时保持签名兼容。

    wait_for_reply: 非 None 时，plan_node 在推送大纲后挂起等待用户确认（human-in-the-loop）。
    checkpointer 由调用方（_run_agent）管理生命周期，通过参数注入。
    """
    search = SearchAgent()
    agents = _make_agents(style=style, search_fn=search.search_one)

    async def _plan(state: WriterState):
        return await plan_node(state, agents, job_id, push_event, wait_for_reply)

    async def _write(state: WriterState):
        return await write_node(state, agents, job_id, push_event)

    async def _review(state: WriterState):
        return await review_node(state, agents, job_id, push_event)

    async def _export(state: WriterState):
        return await export_node(state, job_id, push_event)

    builder = StateGraph(WriterState)
    builder.add_node("plan", _plan)
    builder.add_node("write", _write)
    builder.add_node("review", _review)
    builder.add_node("export", _export)

    builder.add_edge(START, "plan")
    builder.add_edge("plan", "write")
    builder.add_edge("write", "review")
    builder.add_conditional_edges("review", should_rewrite)
    builder.add_edge("export", END)

    return builder.compile(checkpointer=checkpointer)
