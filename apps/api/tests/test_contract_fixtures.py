import json
from pathlib import Path

from backend.models import ArticlePatchRequest, JobRequest, ReplyRequest, SSEEvent


FIXTURE_ROOT = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "fixtures"


def _read_json(name: str):
    return json.loads((FIXTURE_ROOT / name).read_text(encoding="utf-8"))


def test_api_fixture_is_accepted_by_current_pydantic_models():
    fixture = _read_json("api-valid.json")

    job = JobRequest.model_validate(fixture["create_job"]["request"])
    reply = ReplyRequest.model_validate(fixture["reply"]["request"])
    patch = ArticlePatchRequest.model_validate(fixture["article"]["patch_request"])

    assert job.topic == "可扩展的 Agent 工程"
    assert reply.outline == ["运行时边界", "Memory 与 Eval"]
    assert patch.content == "# 更新后的内容"


def test_sse_fixtures_are_accepted_by_current_pydantic_model():
    for name in ("sse-complete.json", "sse-cancelled.json", "sse-error.json"):
        history = _read_json(name)
        events = [SSEEvent.model_validate(event) for event in history["events"]]

        assert events
        assert [event.data["_seq"] for event in events] == list(range(len(events)))
