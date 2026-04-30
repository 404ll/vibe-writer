# LangGraph 重构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 LangGraph 替换 vibe-writer 的 Orchestrator，把状态管理、控制流、业务逻辑三者分离。

**Architecture:** 新建 `backend/agent/graph.py` 作为 LangGraph 图定义，`WriterState`（TypedDict）替换 `JobStore` 中的 `JobState`，条件边替换 orchestrator 中的硬编码重写逻辑。原有 agent（Planner/Writer/Reviewer 等）业务逻辑不动，只改调用方式。FastAPI router 改为调用 `graph.invoke()`。

**Tech Stack:** langgraph, Python 3.9+, FastAPI, asyncio

**范围边界（本次不动）：**
- 前端代码
- 各 agent 内部逻辑（planner.py / writer.py / reviewer.py 等）
- SSE 推送机制（push_event 保留）
- 数据库持久化（models_db.py）
- human-in-the-loop（intervention/reply 机制，阶段 4 再处理）

---

## 文件变更地图

| 文件 | 操作 | 说明 |
|------|------|------|
| `backend/agent/graph.py` | **新建** | LangGraph 图定义：WriterState、节点函数、条件边、build_graph() |
| `backend/agent/orchestrator.py` | **删除** | 被 graph.py 完全替代 |
| `backend/models.py` | **修改** | 新增 WriterState、ChapterState TypedDict；保留 SSEEvent、JobRequest 等 |
| `backend/store.py` | **修改** | 移除 JobState 相关逻辑；保留 SSE 队列、reply 机制、event_log |
| `backend/routers/jobs.py` | **修改** | `_run_agent` 改为调用 `graph.invoke()`；其余 API 不动 |
| `backend/requirements.txt` | **修改** | 新增 `langgraph` 依赖 |

---

## Task 1：安装依赖，新增 WriterState

**Files:**
- Modify: `backend/requirements.txt`
- Modify: `backend/models.py`

- [ ] **Step 1: 在 requirements.txt 末尾加入 langgraph**

打开 `backend/requirements.txt`，末尾加一行：
```
langgraph>=0.2.0
```

- [ ] **Step 2: 安装依赖**

```bash
cd vibe-writer && pip install langgraph
```

预期输出：`Successfully installed langgraph-x.x.x`

- [ ] **Step 3: 在 models.py 新增 WriterState 和 ChapterState**

在 `backend/models.py` 末尾追加（不删除任何现有代码）：

```python
from typing import TypedDict

class ChapterState(TypedDict):
    title: str
    content: str
    review_passed: bool
    review_feedback: str
    rewrite_count: int

class WriterState(TypedDict):
    topic: str
    style: str
    target_words: Optional[int]
    outline: list[str]
    chapters: list[ChapterState]
    rewrite_count: int       # 全文重审轮次
    error: Optional[str]
    final_content: str
```

- [ ] **Step 4: 验证导入正常**

```bash
cd vibe-writer && python3 -c "from backend.models import WriterState, ChapterState; print('ok')"
```

预期输出：`ok`

---

## Task 2：新建 graph.py——节点定义

**Files:**
- Create: `backend/agent/graph.py`

- [ ] **Step 1: 新建 graph.py，写入 plan_node**

创建 `backend/agent/graph.py`：

```python
"""
LangGraph 图定义：用节点+条件边替代 Orchestrator 的流水线。

节点只做业务逻辑，返回想修改的 state 字段。
控制流全部在条件边里。
基础设施（SSE 推送）暂时保留在节点内，阶段 4 再抽离。
"""
import asyncio
import logging
import os
import re
from typing import Optional
from langgraph.graph import StateGraph, START, END

from backend.models import WriterState, ChapterState, SSEEvent, StageStatus
from backend.agent.planner import PlannerAgent
from backend.agent.opinion import OpinionAgent
from backend.agent.search import SearchAgent
from backend.agent.writer import WriterAgent
from backend.agent.reviewer import ReviewAgent

log = logging.getLogger("vibe.graph")

# ── Agent 实例（每次 build_graph 调用时创建）──────────────────


def _make_agents(style: str, search_fn):
    return {
        "planner": PlannerAgent(),
        "opinion": OpinionAgent(),
        "writer": WriterAgent(style=style, search_fn=search_fn),
        "reviewer": ReviewAgent(),
    }


# ── 节点函数 ──────────────────────────────────────────────────

async def plan_node(state: WriterState, agents: dict, job_id: str, push_event) -> dict:
    """生成大纲"""
    await push_event(job_id, SSEEvent(event="stage_update", data={"stage": StageStatus.PLAN}))
    chapters = await agents["planner"].plan(state["topic"])
    await push_event(job_id, SSEEvent(event="outline_ready", data={"outline": chapters}))
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


async def write_node(state: WriterState, agents: dict, job_id: str, push_event) -> dict:
    """并行写作所有未完成/未通过的章节"""
    await push_event(job_id, SSEEvent(event="stage_update", data={"stage": StageStatus.WRITE}))

    outline_text = "\n".join(f"{i+1}. {c}" for i, c in enumerate(state["outline"]))
    chapter_words = (
        round(state["target_words"] / len(state["outline"]))
        if state["target_words"] else None
    )

    async def write_chapter(ch: ChapterState, index: int) -> ChapterState:
        # 只处理还没写或 review 不通过的章节
        if ch["content"] != "" and ch["review_passed"]:
            return ch

        await push_event(job_id, SSEEvent(event="generating_opinions", data={"title": ch["title"]}))
        opinions_text, search_queries = await agents["opinion"].generate(
            topic=state["topic"],
            outline=outline_text,
            chapter_title=ch["title"],
        )

        content_parts: list[str] = []
        async for token in agents["writer"].write_stream(
            topic=state["topic"],
            outline=outline_text,
            chapter_title=ch["title"],
            opinions=opinions_text,
            search_hints=search_queries,
            chapter_words=chapter_words,
            review_feedback=ch["review_feedback"],
        ):
            content_parts.append(token)
            await push_event(job_id, SSEEvent(
                event="writing_chapter",
                data={"title": ch["title"], "token": token},
            ))

        return ChapterState(
            title=ch["title"],
            content="".join(content_parts),
            review_passed=False,
            review_feedback=ch["review_feedback"],
            rewrite_count=ch["rewrite_count"],
        )

    tasks = [write_chapter(ch, i) for i, ch in enumerate(state["chapters"])]
    updated_chapters = list(await asyncio.gather(*tasks))
    return {"chapters": updated_chapters}


async def review_node(state: WriterState, agents: dict, job_id: str, push_event) -> dict:
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


async def export_node(state: WriterState, job_id: str, push_event) -> dict:
    """拼接并保存最终文章"""
    await push_event(job_id, SSEEvent(event="stage_update", data={"stage": StageStatus.EXPORT}))

    lines = [f"# {state['topic']}\n"]
    for ch in state["chapters"]:
        lines.append(f"\n## {ch['title']}\n{ch['content']}")
    markdown = "\n".join(lines)

    slug = re.sub(r'[^\w\-\u4e00-\u9fff]', '-', state["topic"])[:30].rstrip('-') or 'output'
    output_path = f"output/{slug}.md"
    os.makedirs("output", exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(markdown)

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
```

- [ ] **Step 2: 验证语法正确**

```bash
cd vibe-writer && python3 -c "from backend.agent.graph import plan_node, write_node, review_node, export_node, should_rewrite; print('ok')"
```

预期输出：`ok`

---

## Task 3：完成 graph.py——组装图和 build_graph()

**Files:**
- Modify: `backend/agent/graph.py`（追加）

- [ ] **Step 1: 在 graph.py 末尾追加 build_graph 函数**

```python
# ── 组装图 ────────────────────────────────────────────────────

def build_graph(job_id: str, style: str, target_words: Optional[int], push_event):
    """
    构建并编译 LangGraph 图。
    每次任务创建时调用一次，agent 实例和 job_id 通过闭包注入节点。

    为什么用闭包而不是全局变量？
    每个任务有独立的 job_id 和 style，闭包让节点函数携带这些上下文，
    同时保持节点签名符合 LangGraph 要求（只接收 state）。
    """
    search = SearchAgent()
    agents = _make_agents(style=style, search_fn=search.search_one)

    # 用闭包把 agents/job_id/push_event 注入每个节点
    async def _plan(state: WriterState):
        return await plan_node(state, agents, job_id, push_event)

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

    return builder.compile()
```

- [ ] **Step 2: 验证完整导入**

```bash
cd vibe-writer && python3 -c "from backend.agent.graph import build_graph; print('ok')"
```

预期输出：`ok`

---

## Task 4：修改 store.py——移除 JobState 依赖

**Files:**
- Modify: `backend/store.py`

store.py 保留 SSE 队列、reply 机制、event_log，移除 JobState 的创建和 update 逻辑，改为只存 job_id 的元数据（topic/style/target_words）供 router 查询。

- [ ] **Step 1: 替换 store.py 全部内容**

```python
import asyncio
from typing import Optional
from backend.models import SSEEvent, InterventionConfig


class JobStore:
    """
    轻量化 Job 存储。
    业务状态已迁移到 LangGraph WriterState。
    本类只保留：
    - 元数据（topic/style/target_words）供 API 查询
    - SSE 事件队列（实时推送）
    - 用户 reply 机制（human-in-the-loop）
    - 事件历史日志（断线重连回放）
    - 取消标志
    """

    def __init__(self):
        self._meta: dict[str, dict] = {}           # job_id → {topic, style, target_words}
        self._reply_events: dict[str, asyncio.Event] = {}
        self._replies: dict[str, str] = {}
        self._event_logs: dict[str, list[SSEEvent]] = {}
        self._cancel_flags: dict[str, bool] = {}

    def create_job(self, job_id: str, topic: str, style: str = "",
                   target_words: Optional[int] = None,
                   intervention: Optional[InterventionConfig] = None):
        self._meta[job_id] = {
            "topic": topic,
            "style": style,
            "target_words": target_words,
            "intervention": intervention or InterventionConfig(),
        }
        self._reply_events[job_id] = asyncio.Event()
        self._event_logs[job_id] = []
        self._cancel_flags[job_id] = False

    def get_meta(self, job_id: str) -> Optional[dict]:
        return self._meta.get(job_id)

    def exists(self, job_id: str) -> bool:
        return job_id in self._meta

    def set_reply(self, job_id: str, message: str):
        self._replies[job_id] = message
        if job_id in self._reply_events:
            self._reply_events[job_id].set()

    def get_reply(self, job_id: str) -> Optional[str]:
        return self._replies.get(job_id)

    async def wait_for_reply(self, job_id: str) -> str:
        event = self._reply_events.get(job_id)
        if event:
            await event.wait()
        return self._replies.get(job_id, "")

    def append_event(self, job_id: str, event: SSEEvent):
        if job_id in self._event_logs:
            self._event_logs[job_id].append(event)

    def get_events(self, job_id: str) -> list[SSEEvent]:
        return self._event_logs.get(job_id, [])

    def cancel(self, job_id: str):
        self._cancel_flags[job_id] = True
        if job_id in self._reply_events:
            self._reply_events[job_id].set()

    def is_cancelled(self, job_id: str) -> bool:
        return self._cancel_flags.get(job_id, False)


job_store = JobStore()
```

- [ ] **Step 2: 验证导入**

```bash
cd vibe-writer && python3 -c "from backend.store import job_store; print('ok')"
```

预期输出：`ok`

---

## Task 5：修改 routers/jobs.py——接入 graph

**Files:**
- Modify: `backend/routers/jobs.py`

- [ ] **Step 1: 替换 create_job 和 _run_agent**

将 `jobs.py` 中的 `create_job` 和 `_run_agent` 函数替换为：

```python
import uuid

@router.post("")
async def create_job(req: JobRequest):
    job_id = str(uuid.uuid4())
    job_store.create_job(
        job_id=job_id,
        topic=req.topic,
        style=req.style,
        target_words=req.target_words,
        intervention=req.intervention,
    )
    asyncio.create_task(_run_agent(job_id))
    return {"job_id": job_id}


async def _run_agent(job_id: str):
    from backend.agent.graph import build_graph
    meta = job_store.get_meta(job_id)
    if not meta:
        return

    graph = build_graph(
        job_id=job_id,
        style=meta["style"],
        target_words=meta["target_words"],
        push_event=push_event,
    )

    initial_state: WriterState = {
        "topic": meta["topic"],
        "style": meta["style"],
        "target_words": meta["target_words"],
        "outline": [],
        "chapters": [],
        "rewrite_count": 0,
        "error": None,
        "final_content": "",
    }

    try:
        await graph.ainvoke(initial_state)
    except Exception as e:
        log.error("graph failed job_id=%s err=%s", job_id, e)
        await push_event(job_id, SSEEvent(event="error", data={"message": str(e)}))
```

- [ ] **Step 2: 在 jobs.py 顶部补充缺失的 import**

确保文件顶部有这些 import：
```python
import uuid
import logging
from backend.models import JobRequest, ReplyRequest, SSEEvent, WriterState

log = logging.getLogger("vibe.jobs")
```

- [ ] **Step 3: 验证 router 导入正常**

```bash
cd vibe-writer && python3 -c "from backend.routers.jobs import router; print('ok')"
```

预期输出：`ok`

---

## Task 6：删除 orchestrator.py，启动验证

**Files:**
- Delete: `backend/agent/orchestrator.py`

- [ ] **Step 1: 确认没有其他文件 import orchestrator**

```bash
grep -r "orchestrator" /Users/0xelemen/myself/practice/vibe-writer/backend --include="*.py" -l
```

预期输出：只有 `orchestrator.py` 自身（或者 jobs.py 里的旧 import，已在 Task 5 替换）。

- [ ] **Step 2: 删除 orchestrator.py**

```bash
rm /Users/0xelemen/myself/practice/vibe-writer/backend/agent/orchestrator.py
```

- [ ] **Step 3: 启动后端，验证无报错**

```bash
cd vibe-writer && python3 -m uvicorn backend.main:app --reload
```

预期：服务启动，无 ImportError。

- [ ] **Step 4: 发一个测试请求**

```bash
curl -X POST http://localhost:8000/jobs \
  -H "Content-Type: application/json" \
  -d '{"topic": "测试", "style": "", "target_words": null}'
```

预期：返回 `{"job_id": "..."}` 格式的 JSON。

---

## 自检

**Spec coverage：**
- [x] WriterState 替换 JobStore 业务状态
- [x] 条件边替换硬编码两轮重写
- [x] orchestrator.py 删除
- [x] 前端 API 接口不变（job_id 返回、SSE 流、reply 端点均保留）
- [x] 各 agent 内部逻辑不动

**不在本次范围内（后续阶段）：**
- human-in-the-loop（intervention/reply → LangGraph interrupt）
- SSE 推送抽离为 callback/middleware
- checkpointer 持久化
