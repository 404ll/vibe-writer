import re
from dataclasses import dataclass, field
from backend.agent.base import BaseAgent
from backend.agent.prompts import (
    CHAPTER_REVIEW_SYSTEM, CHAPTER_REVIEW_USER,
    FULL_REVIEW_SYSTEM, FULL_REVIEW_USER,
)


@dataclass
class ReviewResult:
    passed: bool
    feedback: str = field(default="")


class ReviewAgent(BaseAgent):
    """
    审稿 Agent，提供两种审稿模式：
    - review_chapter: 轻审，检查单章连贯性和完整度
    - review_full: 重审，检查全文整体质量
    两种模式不通过时均返回 feedback，由 Orchestrator 决定是否重写。
    """

    async def review_chapter(
        self,
        chapter_title: str,
        content: str,
        outline: str,
    ) -> ReviewResult:
        """轻审：连贯性 + 内容完整度。返回 ReviewResult。"""
        raw = await self._call_llm(
            CHAPTER_REVIEW_SYSTEM,
            CHAPTER_REVIEW_USER.format(
                outline=outline,
                chapter_title=chapter_title,
                content=content,
            ),
            max_tokens=512,
        )
        return self._parse_chapter_result(raw)

    async def review_full(
        self,
        topic: str,
        chapters: list[dict],
    ) -> list[ReviewResult]:
        """重审：全文整体质量。返回与 chapters 等长的 ReviewResult 列表。"""
        full_text = "\n\n".join(
            f"## {ch['title']}\n{ch['content']}" for ch in chapters
        )
        raw = await self._call_llm(
            FULL_REVIEW_SYSTEM,
            FULL_REVIEW_USER.format(topic=topic, full_text=full_text),
            max_tokens=1024,
        )
        results = self._parse_full_results(raw, len(chapters))
        return results

    def _parse_chapter_result(self, raw: str) -> ReviewResult:
        """解析轻审输出：PASSED 或 FAILED + 理由/建议。"""
        raw = raw.strip()
        if raw.startswith("PASSED"):
            return ReviewResult(passed=True, feedback="")
        # FAILED 分支：提取理由和建议
        feedback_lines = []
        for line in raw.splitlines():
            if line.startswith("FAILED"):
                continue
            feedback_lines.append(line)
        return ReviewResult(passed=False, feedback="\n".join(feedback_lines).strip())

    def _parse_full_results(self, raw: str, expected_count: int) -> list[ReviewResult]:
        """
        解析重审输出，格式：
          章节1: PASSED
          章节2: FAILED
          理由：xxx
          建议：xxx
        解析失败时所有章节默认 PASSED（不中断流程）。
        """
        results: list[ReviewResult] = []
        # 按"章节N:"分割
        segments = re.split(r'章节\d+:', raw)
        segments = [s.strip() for s in segments if s.strip()]

        for seg in segments:
            if seg.startswith("PASSED"):
                results.append(ReviewResult(passed=True, feedback=""))
            elif seg.startswith("FAILED"):
                feedback_lines = [
                    line for line in seg.splitlines()
                    if not line.startswith("FAILED")
                ]
                results.append(ReviewResult(
                    passed=False,
                    feedback="\n".join(feedback_lines).strip(),
                ))
            else:
                # 无法识别的格式，默认 PASSED
                results.append(ReviewResult(passed=True, feedback=""))

        # 数量不匹配时用 PASSED 填充（容错）
        while len(results) < expected_count:
            results.append(ReviewResult(passed=True, feedback=""))

        return results[:expected_count]
