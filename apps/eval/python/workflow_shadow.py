"""Run the current Python LangGraph with scripted, side-effect-free adapters.

The scenario is supplied on stdin. Stdout contains exactly one normalized JSON
observation so the TypeScript Eval target can compare both runtimes.
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
from typing import Any

from backend.agent import graph as graph_module
from backend.agent.reviewer import ReviewResult
from backend.models import ReplyRequest, SSEEvent, StageStatus


def canonical_markdown(value: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", value.strip())


async def execute(scenario: dict[str, Any]) -> dict[str, Any]:
    context: dict[str, Any] = {
        "write_calls": 0,
        "full_review_calls": 0,
    }
    events: list[dict[str, Any]] = []

    class ScriptedPlanner:
        async def plan(self, topic: str, target_words: int | None = None) -> list[str]:
            del topic, target_words
            return list(scenario["initial_outline"])

        def _trim_outline_for_budget(
            self, chapters: list[str], target_words: int | None
        ) -> list[str]:
            del target_words
            return list(chapters)

        async def _call_llm(self, system: str, user: str) -> str:
            del system, user
            raise RuntimeError("outline revision is not scripted in this dataset")

        def _parse_outline(self, raw: str) -> list[str]:
            return [line.strip() for line in raw.splitlines() if line.strip()]

    class ScriptedOpinion:
        async def generate(
            self, topic: str, outline: str, chapter_title: str
        ) -> tuple[str, list[str]]:
            del topic, outline
            return f"- 覆盖 {chapter_title}", []

    class ScriptedWriter:
        def __init__(self, style: str = "", search_fn=None):
            self._style_instruction = style
            self._search_fn = search_fn

        async def write_stream(self, **inputs):
            context["write_calls"] += 1
            title = inputs["chapter_title"]
            yield f"{title}正文-v{context['write_calls']}"

    class ScriptedReviewer:
        async def review_chapter(self, **inputs) -> ReviewResult:
            del inputs
            return ReviewResult(passed=True, feedback="")

        async def review_full(self, **inputs) -> list[ReviewResult]:
            chapters = inputs["chapters"]
            index = context["full_review_calls"]
            rounds = scenario["full_review_rounds"]
            if index >= len(rounds):
                raise RuntimeError("missing scripted full-review round")
            verdicts = rounds[index]
            if len(verdicts) != len(chapters):
                raise RuntimeError("full-review round does not match chapter cardinality")
            context["full_review_calls"] += 1
            return [
                ReviewResult(
                    passed=verdict == "passed",
                    feedback="" if verdict == "passed" else "补充论证",
                )
                for verdict in verdicts
            ]

    class ScriptedSearch:
        async def search_one(self, query: str) -> str:
            return f"scripted search: {query}"

    def make_agents(style: str, search_fn):
        return {
            "planner": ScriptedPlanner(),
            "opinion": ScriptedOpinion(),
            "writer": ScriptedWriter(style=style, search_fn=search_fn),
            "reviewer": ScriptedReviewer(),
        }

    async def export_without_side_effects(state, job_id: str, push_event):
        await push_event(
            job_id,
            SSEEvent(event="stage_update", data={"stage": StageStatus.EXPORT}),
        )
        lines = [f"# {state['topic']}\n"]
        for chapter in state["chapters"]:
            lines.append(f"\n## {chapter['title']}\n{chapter['content']}")
        markdown = "\n".join(lines)
        await push_event(
            job_id,
            SSEEvent(
                event="done",
                data={"output_path": "shadow://article.md", "article_id": "shadow"},
            ),
        )
        return {"final_content": markdown}

    graph_module.SearchAgent = ScriptedSearch
    graph_module.WriterAgent = ScriptedWriter
    graph_module._make_agents = make_agents
    graph_module.export_node = export_without_side_effects

    async def push_event(job_id: str, event: SSEEvent) -> None:
        del job_id
        events.append(event.model_dump(mode="json"))

    replies = [ReplyRequest.model_validate(reply) for reply in scenario["replies"]]

    async def wait_for_reply(job_id: str) -> ReplyRequest:
        del job_id
        if not replies:
            raise RuntimeError("missing scripted outline reply")
        return replies.pop(0)

    graph = graph_module.build_graph(
        job_id=f"shadow-{scenario['id']}",
        style="",
        target_words=None,
        push_event=push_event,
        wait_for_reply=wait_for_reply if scenario["intervention_on_outline"] else None,
    )
    result = await graph.ainvoke(
        {
            "topic": scenario["topic"],
            "style": "",
            "target_words": None,
            "outline": [],
            "chapters": [],
            "rewrite_count": 0,
            "error": None,
            "final_content": "",
        }
    )
    if replies:
        raise RuntimeError("unused scripted outline replies")

    stages = [
        event["data"]["stage"]
        for event in events
        if event["event"] == "stage_update"
    ]
    return {
        "phase": "completed",
        "outline": result["outline"],
        "canonicalMarkdown": canonical_markdown(result["final_content"]),
        "stageSequence": stages,
        "outlineReviewCount": (
            sum(event["event"] == "outline_ready" for event in events)
            if scenario["intervention_on_outline"]
            else 0
        ),
        "writeCalls": context["write_calls"],
        "fullReviewCalls": context["full_review_calls"],
    }


def main() -> None:
    scenario = json.load(sys.stdin)
    observation = asyncio.run(execute(scenario))
    json.dump(observation, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
