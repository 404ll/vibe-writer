# Phase 5c: Writing Style Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在开始写作前选择写作风格（预设列表或自定义），风格描述注入 WriterAgent system prompt。

**Architecture:** `JobRequest` 新增 `style: str` 字段，经 `Orchestrator` 传给 `WriterAgent`；`WriterAgent.__init__` 接收 style，在 `_call_llm` 时将风格指令追加到 system prompt 末尾。前端 `InputPanel` 新增风格下拉（选"自定义"时显示文本输入框），`App.tsx` 传 style 给后端。同时清理 `InputPanel.tsx` 中残留的 `on_chapter` 代码。

**Tech Stack:** Python, FastAPI, React 18, TypeScript

---

## File Map

| 文件 | 变更 |
|------|------|
| `backend/models.py` | `JobRequest` + `JobState` 新增 `style: str = ""` |
| `backend/store.py` | `create_job` 接收 `style` 参数 |
| `backend/routers/jobs.py` | `create_job` 和 `_run_agent` 传 style |
| `backend/agent/orchestrator.py` | `__init__` 接收 style，传给 `WriterAgent` |
| `backend/agent/writer.py` | 新增 `STYLE_PROMPTS`；`__init__` 接收 style；system prompt 注入风格 |
| `frontend/src/components/InputPanel.tsx` | 新增风格下拉 + 自定义输入框；清理 `on_chapter` 残留 |
| `frontend/src/App.tsx` | `handleSubmit` 传 style |
| `tests/test_writer.py` | 新增 2 个风格测试 |

---

## Task 1: 后端 — style 字段贯穿 models → store → router → orchestrator → writer

**Files:**
- Modify: `backend/models.py`
- Modify: `backend/store.py`
- Modify: `backend/routers/jobs.py`
- Modify: `backend/agent/orchestrator.py`
- Modify: `backend/agent/writer.py`
- Modify: `tests/test_writer.py`

- [ ] **Step 1: 在 tests/test_writer.py 末尾追加两个失败测试**

```python
def test_style_instruction_injected_into_system_prompt():
    """预设风格'科普'时，_style_instruction 包含对应指令"""
    from backend.agent.writer import WriterAgent
    with patch("backend.agent.base.anthropic.AsyncAnthropic"):
        agent = WriterAgent(style="科普")
    assert "普通读者" in agent._style_instruction

def test_custom_style_used_as_instruction():
    """自定义风格原样作为指令"""
    from backend.agent.writer import WriterAgent
    with patch("backend.agent.base.anthropic.AsyncAnthropic"):
        agent = WriterAgent(style="幽默风趣，多用梗")
    assert agent._style_instruction == "幽默风趣，多用梗"
```

- [ ] **Step 2: 运行新测试确认失败**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_writer.py::test_style_instruction_injected_into_system_prompt tests/test_writer.py::test_custom_style_used_as_instruction -v
```
Expected: FAIL（`WriterAgent` 不接受 `style` 参数）

- [ ] **Step 3: 修改 backend/models.py**

将 `JobRequest` 和 `JobState` 替换为（其余类不变）：

```python
class JobRequest(BaseModel):
    topic: str
    intervention: InterventionConfig = Field(default_factory=InterventionConfig)
    style: str = ""

class JobState(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    topic: str
    stage: StageStatus = StageStatus.PLAN
    outline: Optional[list[str]] = None
    chapters: list[dict] = Field(default_factory=list)
    intervention: InterventionConfig = Field(default_factory=InterventionConfig)
    style: str = ""
    error: Optional[str] = None
```

- [ ] **Step 4: 修改 backend/store.py — create_job 接收 style**

将 `create_job` 方法替换为（其余方法不变）：

```python
    def create_job(self, topic: str, intervention=None, style: str = "") -> JobState:
        """创建新 Job，分配 UUID，初始化对应的 asyncio.Event 和 event_log"""
        job = JobState(
            topic=topic,
            intervention=intervention or InterventionConfig(),
            style=style,
        )
        self._jobs[job.id] = job
        self._reply_events[job.id] = asyncio.Event()
        self._event_logs[job.id] = []
        return job
```

注意：如果 5a 尚未实现，`_event_logs` 行不存在，只需添加 `style=style` 到 `JobState(...)` 调用，并在 `create_job` 签名加 `style: str = ""`。

- [ ] **Step 5: 修改 backend/routers/jobs.py — create_job 和 _run_agent 传 style**

`create_job` 端点中：
```python
job = job_store.create_job(req.topic, req.intervention, req.style)
```

`_run_agent` 中：
```python
orch = Orchestrator(
    job_id=job_id,
    topic=job.topic,
    intervention_on_outline=job.intervention.on_outline,
    style=job.style,
)
```

- [ ] **Step 6: 修改 backend/agent/orchestrator.py — __init__ 接收 style**

将 `__init__` 替换为：

```python
    def __init__(
        self,
        job_id: str,
        topic: str,
        intervention_on_outline: bool = True,
        style: str = "",
    ):
        self.job_id = job_id
        self.topic = topic
        self.intervention_on_outline = intervention_on_outline
        self._planner = PlannerAgent()
        self._search = SearchAgent()
        self._writer = WriterAgent(style=style)
        self._reviewer = ReviewAgent()
```

- [ ] **Step 7: 修改 backend/agent/writer.py**

将 `backend/agent/writer.py` 完整替换为：

```python
from backend.agent.base import BaseAgent
from backend.agent.prompts import CHAPTER_SYSTEM, CHAPTER_USER

STYLE_PROMPTS = {
    "技术博客": "写作风格：面向有经验的开发者，逻辑严密，代码示例充足，避免废话。",
    "科普":     "写作风格：面向普通读者，多用类比和生活化比喻，避免术语堆砌。",
    "教程":     "写作风格：手把手教学，步骤清晰，每步有预期结果，适合初学者跟随操作。",
}

class WriterAgent(BaseAgent):
    """
    负责根据章节标题、大纲和参考资料撰写章节正文。
    输入：topic, outline, chapter_title, research, style（可选）
    输出：章节正文 Markdown 字符串
    """

    def __init__(self, style: str = ""):
        super().__init__()
        # 预设风格取对应指令；自定义风格原样使用；空字符串不注入
        self._style_instruction = STYLE_PROMPTS.get(style, style)

    async def write(
        self,
        topic: str,
        outline: str,
        chapter_title: str,
        research: str,
        review_feedback: str = "",
    ) -> str:
        """
        调用 LLM 写章节正文。
        research 为空时 prompt 中显示"暂无参考资料"。
        review_feedback 非空时在 prompt 末尾追加审稿意见，用于重写场景。
        style 非空时在 system prompt 末尾追加风格指令。
        """
        system = CHAPTER_SYSTEM
        if self._style_instruction:
            system += f"\n\n{self._style_instruction}"

        research_text = research if research.strip() else "暂无参考资料"
        user_prompt = CHAPTER_USER.format(
            topic=topic,
            outline=outline,
            chapter_title=chapter_title,
            research=research_text,
        )
        if review_feedback.strip():
            user_prompt += f"\n\n审稿意见：{review_feedback}\n请根据以上意见修改章节内容。"
        return await self._call_llm(system, user_prompt)
```

- [ ] **Step 8: 运行新测试确认通过**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_writer.py -v
```
Expected: 6 passed（原 4 个 + 新 2 个）

- [ ] **Step 9: 运行全量测试确认无回归**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/ -v 2>&1 | tail -5
```
Expected: 全部通过

- [ ] **Step 10: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add backend/models.py backend/store.py backend/routers/jobs.py backend/agent/orchestrator.py backend/agent/writer.py tests/test_writer.py
git commit -m "feat: writing style — style field through models/store/router/orchestrator/writer"
```

---

## Task 2: 前端 — 风格选择 UI + 清理 on_chapter 残留

**Files:**
- Modify: `frontend/src/components/InputPanel.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: 将 frontend/src/components/InputPanel.tsx 完整替换为**

```tsx
import { useState } from 'react'
import type { InterventionConfig } from '../types'

const PRESET_STYLES = ['技术博客', '科普', '教程', '自定义'] as const
type PresetStyle = typeof PRESET_STYLES[number] | ''

interface Props {
  onSubmit: (topic: string, intervention: InterventionConfig, style: string) => void
  disabled: boolean
}

export function InputPanel({ onSubmit, disabled }: Props) {
  const [topic, setTopic] = useState('')
  const [onOutline, setOnOutline] = useState(true)
  const [selectedStyle, setSelectedStyle] = useState<PresetStyle>('')
  const [customStyle, setCustomStyle] = useState('')

  function handleSubmit() {
    if (!topic.trim()) return
    const style = selectedStyle === '自定义' ? customStyle.trim() : selectedStyle
    onSubmit(topic, { on_outline: onOutline }, style)
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '10px', flexShrink: 0 }}>
      <div className="card-label">写作主题</div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <label htmlFor="topic-input" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
          写作主题
        </label>
        <input
          id="topic-input"
          type="text"
          name="topic"
          placeholder="输入写作主题，例如：RAG 检索增强生成…"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          autoComplete="search"
          disabled={disabled}
          style={{
            flex: 1,
            minWidth: 0,
            padding: '8px 12px',
            border: '1px solid var(--border-input)',
            borderRadius: '5px',
            fontSize: '14px',
            color: 'var(--text-h)',
            background: disabled ? 'var(--input-bg)' : 'var(--card-bg)',
            fontFamily: 'var(--sans)',
          }}
        />
        <button
          type="button"
          className="btn-primary"
          onClick={handleSubmit}
          disabled={disabled || !topic.trim()}
        >
          开始写作
        </button>
      </div>

      {/* 介入配置 + 风格选择 */}
      <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={onOutline}
            onChange={(e) => setOnOutline(e.target.checked)}
            disabled={disabled}
          />
          大纲生成后介入
        </label>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <label htmlFor="style-select" style={{ fontSize: '13px', color: 'var(--text)', whiteSpace: 'nowrap' }}>
            写作风格
          </label>
          <select
            id="style-select"
            value={selectedStyle}
            onChange={(e) => setSelectedStyle(e.target.value as PresetStyle)}
            disabled={disabled}
            style={{
              padding: '4px 8px',
              border: '1px solid var(--border-input)',
              borderRadius: '5px',
              fontSize: '13px',
              color: 'var(--text-h)',
              background: disabled ? 'var(--input-bg)' : 'var(--card-bg)',
              fontFamily: 'var(--sans)',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            <option value="">不指定</option>
            {PRESET_STYLES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      {/* 自定义风格输入框 */}
      {selectedStyle === '自定义' && (
        <input
          type="text"
          placeholder="描述你想要的写作风格，例如：幽默风趣，多用类比…"
          value={customStyle}
          onChange={(e) => setCustomStyle(e.target.value)}
          disabled={disabled}
          style={{
            padding: '7px 12px',
            border: '1px solid var(--border-input)',
            borderRadius: '5px',
            fontSize: '13px',
            color: 'var(--text-h)',
            background: disabled ? 'var(--input-bg)' : 'var(--card-bg)',
            fontFamily: 'var(--sans)',
          }}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: 修改 frontend/src/App.tsx — handleSubmit 接收 style**

将 `handleSubmit` 函数替换为：

```typescript
  async function handleSubmit(topic: string, intervention: InterventionConfig, style: string) {
    const res = await fetch(`${API_BASE}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, intervention, style }),
    })
    const { job_id } = await res.json()
    setLastTopic(topic)
    setJob({ ...INITIAL_JOB, jobId: job_id })
    setCompletedChapters(0)
    setAwaitingReview(false)
    setActivityLog([])
  }
```

- [ ] **Step 3: 运行 TypeScript 类型检查**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer/frontend && npx tsc --noEmit 2>&1
```
Expected: 无错误

- [ ] **Step 4: 运行全量后端测试确认无回归**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/ -v 2>&1 | tail -5
```
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add frontend/src/components/InputPanel.tsx frontend/src/App.tsx
git commit -m "feat: writing style selector in InputPanel, pass style to backend"
```

---

## Self-Review Checklist

| Spec 要求 | Task |
|-----------|------|
| `JobRequest.style: str = ""` | Task 1 Step 3 |
| `JobState.style: str = ""` | Task 1 Step 3 |
| `create_job` 接收 style | Task 1 Step 4 |
| `_run_agent` 传 style 给 Orchestrator | Task 1 Step 5 |
| `Orchestrator.__init__` 接收 style，传给 WriterAgent | Task 1 Step 6 |
| `STYLE_PROMPTS` 字典（技术博客/科普/教程） | Task 1 Step 7 |
| `WriterAgent.__init__` 接收 style，设置 `_style_instruction` | Task 1 Step 7 |
| 自定义风格原样透传 | Task 1 Step 7 |
| system prompt 末尾追加风格指令 | Task 1 Step 7 |
| 测试：预设风格注入正确指令 | Task 1 Step 1 |
| 测试：自定义风格原样使用 | Task 1 Step 1 |
| 前端风格下拉（4 个预设 + 不指定） | Task 2 Step 1 |
| 选"自定义"时显示文本输入框 | Task 2 Step 1 |
| `on_chapter` 残留清理 | Task 2 Step 1 |
| `App.tsx` 传 style 给后端 | Task 2 Step 2 |
