import logging
from dataclasses import dataclass, field
from typing import Optional
from backend.agent.base import BaseAgent
from backend.agent.prompts import (
    CHAPTER_REVIEW_SYSTEM, CHAPTER_REVIEW_USER,
    FULL_REVIEW_SYSTEM, FULL_REVIEW_USER,
    chapter_word_limit_line,
    article_word_limit_line,
)

log = logging.getLogger("vibe.reviewer")


@dataclass
class ReviewResult:
    passed: bool
    feedback: str = field(default="")


def _count_chars(text: str) -> int:
    return len(text.replace(" ", "").replace("\n", ""))


class ReviewAgent(BaseAgent):
    """审稿：轻审单章、重审全文。"""

    async def review_chapter(
        self,
        chapter_title: str,
        content: str,
        outline: str,
        chapter_words: Optional[int] = None,
    ) -> ReviewResult:
        """轻审：连贯性 + 完整度 + 客观性 + 篇幅。"""
        if chapter_words:
            actual = _count_chars(content)
            hard_max = round(chapter_words * 1.15)
            if actual > hard_max:
                return ReviewResult(
                    passed=False,
                    feedback=(
                        f"本章约 {actual} 字，超过上限 {chapter_words} 字（允许至 {hard_max} 字）。"
                        "请删减冗余表述，保留核心事实与机制说明。"
                    ),
                )

        data = await self._call_llm_json(
            CHAPTER_REVIEW_SYSTEM,
            CHAPTER_REVIEW_USER.format(
                outline=outline,
                chapter_title=chapter_title,
                word_limit_line=chapter_word_limit_line(chapter_words),
                content=content,
            ),
            max_tokens=512,
        )
        if not data:
            log.warning("review_chapter: JSON parse failed, defaulting to PASSED  chapter=%r", chapter_title)
            return ReviewResult(passed=True, feedback="")
        return ReviewResult(
            passed=bool(data.get("passed", True)),
            feedback=data.get("feedback", ""),
        )

    async def review_full(
        self,
        topic: str,
        chapters: list[dict],
        target_words: Optional[int] = None,
    ) -> list[ReviewResult]:
        """重审：全文质量与总篇幅。"""
        full_text = "\n\n".join(
            f"## {ch['title']}\n{ch['content']}" for ch in chapters
        )
        if target_words:
            total = _count_chars(full_text)
            hard_max = round(target_words * 1.1)
            if total > hard_max:
                log.warning(
                    "review_full: over word budget  total=%d  limit=%d",
                    total, target_words,
                )
                return [
                    ReviewResult(
                        passed=False,
                        feedback=(
                            f"全文约 {total} 字，超过用户上限 {target_words} 字。"
                            "请压缩各章，删除重复与煽情表述。"
                        ),
                    )
                    for _ in chapters
                ]

        data = await self._call_llm_json(
            FULL_REVIEW_SYSTEM,
            FULL_REVIEW_USER.format(
                topic=topic,
                word_limit_line=article_word_limit_line(target_words),
                full_text=full_text,
            ),
            max_tokens=1024,
        )
        if not data or "results" not in data:
            log.warning("review_full: JSON parse failed, defaulting all to PASSED  topic=%r", topic)
            return [ReviewResult(passed=True, feedback="") for _ in chapters]

        results = [
            ReviewResult(
                passed=bool(r.get("passed", True)),
                feedback=r.get("feedback", ""),
            )
            if isinstance(r, dict)
            else ReviewResult(passed=True, feedback="")
            for r in data["results"]
        ]
        while len(results) < len(chapters):
            results.append(ReviewResult(passed=True, feedback=""))
        return results[:len(chapters)]
