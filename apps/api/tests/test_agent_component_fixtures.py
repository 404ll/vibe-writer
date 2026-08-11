import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend.agent.base import BaseAgent, _parse_json_from_text
from backend.agent.planner import PlannerAgent
from backend.agent.reviewer import ReviewAgent
from backend.agent.opinion import OpinionAgent
from backend.agent.search import SearchAgent, _rank_results_by_recency
from backend.agent.graph import should_rewrite


FIXTURE_PATH = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "contracts"
    / "fixtures"
    / "agent-component-baseline.json"
)

RESEARCH_FIXTURE_PATH = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "contracts"
    / "fixtures"
    / "opinion-search-baseline.json"
)

WRITER_FIXTURE_PATH = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "contracts"
    / "fixtures"
    / "writer-tool-baseline.json"
)

WORKFLOW_FIXTURE_PATH = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "contracts"
    / "fixtures"
    / "workflow-control-baseline.json"
)


@pytest.fixture(scope="module")
def fixture():
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def research_fixture():
    return json.loads(RESEARCH_FIXTURE_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def writer_fixture():
    return json.loads(WRITER_FIXTURE_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def workflow_fixture():
    return json.loads(WORKFLOW_FIXTURE_PATH.read_text(encoding="utf-8"))


def test_planner_compatibility_cases(fixture):
    planner = PlannerAgent.__new__(PlannerAgent)

    for case in fixture["planner_outline_cases"]:
        assert planner._parse_outline(case["raw"]) == case["expected_chapters"], case["id"]

    for case in fixture["planner_trim_cases"]:
        assert planner._trim_outline_for_budget(
            case["chapters"], case["target_words"]
        ) == case["expected_chapters"], case["id"]


def test_json_object_compatibility_cases(fixture):
    for case in fixture["json_object_cases"]:
        parsed = _parse_json_from_text(case["raw"])
        assert (parsed or None) == case["expected"], case["id"]


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", ["chapter", "full"])
async def test_reviewer_compatibility_verdicts(fixture, scope):
    cases = [case for case in fixture["reviewer_output_cases"] if case["scope"] == scope]

    for case in cases:
        reviewer = ReviewAgent.__new__(ReviewAgent)
        reviewer._call_llm_json = AsyncMock(return_value=_parse_json_from_text(case["raw"]))
        chapters = [
            {"title": f"章节 {index + 1}", "content": f"内容 {index + 1}"}
            for index in range(case["chapter_count"])
        ]

        if scope == "chapter":
            result = await reviewer.review_chapter(
                chapter_title=chapters[0]["title"],
                content=chapters[0]["content"],
                outline="1. 章节 1",
            )
            results = [result]
        else:
            results = await reviewer.review_full(topic="测试主题", chapters=chapters)

        verdicts = ["passed" if result.passed else "failed" for result in results]
        assert verdicts == case["compatibility_verdicts"], case["id"]


@pytest.mark.asyncio
async def test_opinion_compatibility_cases(research_fixture):
    for case in research_fixture["coverage_output_cases"]:
        agent = OpinionAgent.__new__(OpinionAgent)
        agent._call_llm_json = AsyncMock(return_value=_parse_json_from_text(case["raw"]))

        opinions, queries = await agent.generate(
            topic="测试主题",
            outline="1. 测试章节",
            chapter_title="测试章节",
        )
        status = "ready" if opinions or queries else "empty"
        assert status == case["compatibility_status"], case["id"]
        assert opinions == case["compatibility_opinions_text"], case["id"]
        assert queries == case["compatibility_queries"], case["id"]


def test_search_policy_compatibility_cases(research_fixture):
    agent = SearchAgent.__new__(SearchAgent)

    for case in research_fixture["search_policy_cases"]:
        actual = agent._search_params(case["query"])
        expected = {
            "max_results": case["compatibility"]["max_results"],
            "search_depth": case["compatibility"]["search_depth"],
            "days": case["compatibility"]["days"],
        }
        if "topic" in case["compatibility"]:
            expected["topic"] = case["compatibility"]["topic"]
        assert actual == expected, case["id"]


def test_search_ranking_compatibility_cases(research_fixture, monkeypatch):
    class FixtureDateTime(datetime):
        @classmethod
        def utcnow(cls):
            return cls.fromisoformat(research_fixture["as_of_date"])

    monkeypatch.setattr("backend.agent.search.datetime", FixtureDateTime)
    for case in research_fixture["search_ranking_cases"]:
        documents = [
            {"id": document["id"], "published_date": document["published_at"]}
            for document in case["documents"]
        ]
        actual = _rank_results_by_recency(documents, case["news_like"])
        assert [document["id"] for document in actual] == case["compatibility_order"], case["id"]


@pytest.mark.asyncio
async def test_writer_tool_loop_compatibility_cases(writer_fixture):
    for case in writer_fixture["tool_loop_cases"]:
        responses = [
            SimpleNamespace(
                stop_reason=response["stop_reason"],
                content=[SimpleNamespace(**block) for block in response["blocks"]],
            )
            for response in case["responses"]
        ]
        agent = BaseAgent.__new__(BaseAgent)
        agent._client = SimpleNamespace(
            messages=SimpleNamespace(create=AsyncMock(side_effect=responses))
        )
        handlers = {}
        for behavior in case["handlers"]:
            if behavior["kind"] == "error":
                async def failing_handler(query, message=behavior["output"]):
                    raise RuntimeError(message)

                handlers[behavior["name"]] = failing_handler
            else:
                async def returning_handler(query, output=behavior["output"]):
                    return output

                handlers[behavior["name"]] = returning_handler

        text = await agent._call_llm_with_tools(
            system="system",
            user="user",
            tools=[],
            tool_handlers=handlers,
            max_tool_rounds=case["max_tool_rounds"],
        )

        assert text == case["compatibility"]["text"], case["id"]
        assert (
            agent._client.messages.create.call_count
            == case["compatibility"]["model_requests"]
        ), case["id"]
        recorded_messages = agent._client.messages.create.call_args.kwargs["messages"]
        tool_result_messages = [
            message
            for message in recorded_messages
            if message["role"] == "user"
            and isinstance(message["content"], list)
            and message["content"]
            and isinstance(message["content"][0], dict)
            and message["content"][0].get("type") == "tool_result"
        ]
        if case["id"] == "unknown-tool-recovers":
            assert tool_result_messages[0]["content"] == [
                {
                    "type": "tool_result",
                    "tool_use_id": "call-unknown-1",
                    "content": "Unknown tool: missing",
                }
            ]
        if case["id"] == "handler-error-recovers":
            assert tool_result_messages[0]["content"] == [
                {
                    "type": "tool_result",
                    "tool_use_id": "call-error-1",
                    "content": "Error: API secret detail",
                }
            ]


def test_workflow_rewrite_route_compatibility_cases(workflow_fixture):
    for case in workflow_fixture["rewrite_route_cases"]:
        chapters = [
            {
                "title": f"chapter-{index}",
                "content": "content",
                "review_passed": passed,
                "review_feedback": "",
                "rewrite_count": 0,
            }
            for index, passed in enumerate(case["chapter_passed"])
        ]
        state = {"chapters": chapters, "rewrite_count": case["review_count"]}
        assert should_rewrite(state) == case["compatibility_route"], case["id"]
