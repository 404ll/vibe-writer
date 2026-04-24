import os
import re
import anthropic
from backend.models import JobState, StageStatus, SSEEvent
from backend.store import job_store
from backend.routers.jobs import push_event
from backend.agent.prompts import (
    OUTLINE_SYSTEM, OUTLINE_USER,
    CHAPTER_SYSTEM, CHAPTER_USER,
)

class Orchestrator:
    """
    核心 Agent：驱动"规划 → 写作 → 导出"三阶段流水线。

    每个阶段结束后通过 push_event 向前端推送 SSE 事件，
    前端实时更新进度条。如果配置了"介入"选项，则在对应
    节点暂停，等待用户通过 /reply 接口发送确认或修改意见。
    """

    def __init__(self, job_id: str, topic: str, intervention_on_outline: bool = True, intervention_on_chapter: bool = False):
        self.job_id = job_id
        self.topic = topic
        self.intervention_on_outline = intervention_on_outline   # 生成大纲后是否暂停等待用户确认
        self.intervention_on_chapter = intervention_on_chapter   # 每章写完后是否暂停等待用户确认
        # Anthropic 兼容客户端，base_url 指向 Kimi 代理
        self._client = anthropic.AsyncAnthropic(
            api_key=os.environ.get("ANTHROPIC_API_KEY", "placeholder"),
            base_url=os.environ.get("ANTHROPIC_BASE_URL"),
        )

    def _safe_filename(self, text: str, max_len: int = 30) -> str:
        """把主题字符串转成安全的文件名：保留中文、字母、数字、连字符，其余替换为 -"""
        slug = re.sub(r'[^\w\-\u4e00-\u9fff]', '-', text)
        slug = re.sub(r'-+', '-', slug)          # 合并连续的 -
        return slug[:max_len].rstrip('-') or 'output'

    def _parse_outline(self, raw: str) -> list[str]:
        """
        把 LLM 返回的编号列表解析成章节标题数组。
        支持 "1. 标题" 和 "1、标题" 两种格式，忽略空行。
        """
        chapters = []
        for line in raw.strip().splitlines():
            line = line.strip()
            if not line:
                continue
            # 去掉行首的数字编号
            if line[0].isdigit():
                dot_idx = line.find(".")
                space_idx = line.find("、")
                if dot_idx != -1:
                    line = line[dot_idx + 1:].strip()
                elif space_idx != -1:
                    line = line[space_idx + 1:].strip()
            if line:
                chapters.append(line)
        return chapters

    async def _call_llm(self, system: str, user: str) -> str:
        """封装单次 LLM 调用，返回纯文本响应"""
        message = await self._client.messages.create(
            model=os.environ.get("MODEL_ID", "kimi-k2.5"),
            max_tokens=2048,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return message.content[0].text

    async def run(self):
        """
        主流水线，按顺序执行三个阶段：

        PLAN  → 调用 LLM 生成大纲，推送 outline_ready 事件
                 如果 intervention_on_outline=True，暂停等待用户回复
        WRITE → 逐章调用 LLM 写正文，每章完成推送 chapter_done 事件
                 如果 intervention_on_chapter=True，每章后暂停
        EXPORT→ 拼接 Markdown，写入 output/ 目录，推送 done 事件
        """
        job = job_store.get(self.job_id)
        if not job:
            # job 不存在（极少数情况，如服务重启后内存被清空）
            await push_event(self.job_id, SSEEvent(
                event="error", data={"message": "Job not found"}
            ))
            return

        # ── Stage 1: PLAN ──────────────────────────────────────────
        await push_event(self.job_id, SSEEvent(
            event="stage_update", data={"stage": StageStatus.PLAN}
        ))
        raw_outline = await self._call_llm(
            OUTLINE_SYSTEM,
            OUTLINE_USER.format(topic=self.topic),
        )
        chapters = self._parse_outline(raw_outline)
        if job:
            job.outline = chapters
            job_store.update(job)

        # 把大纲推给前端，前端展示 ReviewPanel
        await push_event(self.job_id, SSEEvent(
            event="outline_ready",
            data={"outline": chapters, "raw": raw_outline},
        ))

        if self.intervention_on_outline:
            # 阻塞在这里，直到前端调用 POST /jobs/{id}/reply
            reply = await job_store.wait_for_reply(self.job_id)
            # 如果用户发来的不是简单确认，而是新的大纲文本，则重新解析
            if reply and reply.strip().lower() not in ("ok", "确认", "继续", "yes"):
                chapters = self._parse_outline(reply) or chapters
                if job:
                    job.outline = chapters
                    job_store.update(job)

        # ── Stage 2: WRITE ─────────────────────────────────────────
        if job:
            job.stage = StageStatus.WRITE
            job_store.update(job)
        await push_event(self.job_id, SSEEvent(
            event="stage_update", data={"stage": StageStatus.WRITE}
        ))

        outline_text = "\n".join(f"{i+1}. {c}" for i, c in enumerate(chapters))
        written_chapters = []
        for chapter_title in chapters:
            content = await self._call_llm(
                CHAPTER_SYSTEM,
                CHAPTER_USER.format(
                    topic=self.topic,
                    outline=outline_text,
                    chapter_title=chapter_title,
                ),
            )
            written_chapters.append({"title": chapter_title, "content": content})
            if job:
                job.chapters = written_chapters
                job_store.update(job)
            # 通知前端这一章写完了（用于更新进度计数器）
            await push_event(self.job_id, SSEEvent(
                event="chapter_done",
                data={"title": chapter_title, "index": len(written_chapters) - 1},
            ))
            if self.intervention_on_chapter:
                # 每章后暂停，等待用户确认再继续下一章
                await job_store.wait_for_reply(self.job_id)

        # ── Stage 3: EXPORT ────────────────────────────────────────
        if job:
            job.stage = StageStatus.EXPORT
            job_store.update(job)
        await push_event(self.job_id, SSEEvent(
            event="stage_update", data={"stage": StageStatus.EXPORT}
        ))

        markdown = self._build_markdown(self.topic, written_chapters)
        output_path = f"output/{self._safe_filename(self.topic)}.md"
        os.makedirs("output", exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(markdown)

        if job:
            job.stage = StageStatus.DONE
            job_store.update(job)
        await push_event(self.job_id, SSEEvent(
            event="done", data={"output_path": output_path},
        ))

    def _build_markdown(self, topic: str, chapters: list[dict]) -> str:
        """把章节列表拼成标准 Markdown 文档"""
        lines = [f"# {topic}\n"]
        for ch in chapters:
            lines.append(f"\n## {ch['title']}\n")
            lines.append(ch["content"])
        return "\n".join(lines)
