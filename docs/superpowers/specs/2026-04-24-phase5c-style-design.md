# Phase 5c 设计文档：写作风格 Skill

**日期：** 2026-04-24
**状态：** 待实现

---

## 目标

用户在开始写作前选择写作风格（预设列表或自定义输入），风格描述注入 WriterAgent 的 system prompt，影响整篇文章的语气和结构。

---

## 决策记录

- **注入点：WriterAgent system prompt**，不新建 StyleAgent。理由：YAGNI，直接 prompt 注入效果可验证，复杂度最低。
- **前端交互：预设下拉 + 自定义输入框备选**。预设选"自定义"时显示文本输入框。
- **后端字段：`JobRequest.style: str`**，可选，默认空字符串（空 = 不注入风格指令）。
- **预设风格（4 个）：** `技术博客`、`科普`、`教程`、`自定义`。

---

## 一、后端变更

### 1.1 `backend/models.py`

`JobRequest` 新增可选字段：

```python
class JobRequest(BaseModel):
    topic: str
    intervention: InterventionConfig = Field(default_factory=InterventionConfig)
    style: str = ""
```

`JobState` 新增字段（用于重连后恢复风格信息）：

```python
class JobState(BaseModel):
    ...
    style: str = ""
```

### 1.2 `backend/routers/jobs.py`

`create_job` 时传入 style：

```python
job = job_store.create_job(req.topic, req.intervention, req.style)
```

`_run_agent` 传给 Orchestrator：

```python
orch = Orchestrator(
    job_id=job_id,
    topic=job.topic,
    intervention_on_outline=job.intervention.on_outline,
    style=job.style,
)
```

### 1.3 `backend/store.py`

`create_job` 接收 style 参数：

```python
def create_job(self, topic: str, intervention=None, style: str = "") -> JobState:
    job = JobState(
        topic=topic,
        intervention=intervention or InterventionConfig(),
        style=style,
    )
    ...
```

### 1.4 `backend/agent/orchestrator.py`

`__init__` 接收 style：

```python
def __init__(
    self,
    job_id: str,
    topic: str,
    intervention_on_outline: bool = True,
    style: str = "",
):
    ...
    self.style = style
    self._writer = WriterAgent(style=style)
```

### 1.5 `backend/agent/writer.py`

`WriterAgent.__init__` 接收 style，注入 system prompt：

```python
STYLE_PROMPTS = {
    "技术博客": "写作风格：面向有经验的开发者，逻辑严密，代码示例充足，避免废话。",
    "科普":     "写作风格：面向普通读者，多用类比和生活化比喻，避免术语堆砌。",
    "教程":     "写作风格：手把手教学，步骤清晰，每步有预期结果，适合初学者跟随操作。",
}

class WriterAgent:
    def __init__(self, style: str = ""):
        self._style_instruction = STYLE_PROMPTS.get(style, style)
        # style 不在预设中时，直接把用户输入作为风格指令
```

`write` 方法的 system prompt 末尾追加风格指令：

```python
system = "你是一位专业的技术博客写手..."
if self._style_instruction:
    system += f"\n\n{self._style_instruction}"
```

---

## 二、前端变更

### 2.1 `frontend/src/types.ts`

```typescript
export interface JobRequest {
  topic: string;
  intervention: InterventionConfig;
  style: string;
}
```

（`JobRequest` 类型目前不存在，直接在 `App.tsx` 内联，不需要新建类型）

### 2.2 `frontend/src/components/InputPanel.tsx`

新增 style 选择 UI：

- 下拉 `<select>`：选项为 `技术博客`、`科普`、`教程`、`自定义`、（空 = 不指定）
- 选中"自定义"时，下方出现 `<input type="text">` 让用户输入风格描述
- `onSubmit` 回调签名扩展：`onSubmit(topic, intervention, style)`

### 2.3 `frontend/src/App.tsx`

`handleSubmit` 传入 style：

```typescript
async function handleSubmit(topic: string, intervention: InterventionConfig, style: string) {
  const res = await fetch(`${API_BASE}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, intervention, style }),
  })
  ...
}
```

---

## 三、测试变更

### `tests/test_writer.py`

新增两个测试：

**`test_style_instruction_injected_into_prompt`** — 传入预设风格时，system prompt 包含对应指令：

```python
def test_style_instruction_injected_into_prompt():
    agent = WriterAgent(style="科普")
    # 检查 agent._style_instruction 包含"类比"或"普通读者"等关键词
    assert "普通读者" in agent._style_instruction
```

**`test_custom_style_used_as_instruction`** — 传入自定义风格时，原样注入：

```python
def test_custom_style_used_as_instruction():
    agent = WriterAgent(style="幽默风趣，多用梗")
    assert agent._style_instruction == "幽默风趣，多用梗"
```

---

## 四、文件变更清单

| 文件 | 变更 |
|------|------|
| `backend/models.py` | `JobRequest` + `JobState` 新增 `style: str` |
| `backend/store.py` | `create_job` 接收 style |
| `backend/routers/jobs.py` | 传 style 给 `create_job` 和 `Orchestrator` |
| `backend/agent/orchestrator.py` | `__init__` 接收 style，传给 `WriterAgent` |
| `backend/agent/writer.py` | 新增 `STYLE_PROMPTS`，`__init__` 接收 style，注入 system prompt |
| `frontend/src/components/InputPanel.tsx` | 新增 style 下拉 + 自定义输入框 |
| `frontend/src/App.tsx` | `handleSubmit` 传入 style |
| `tests/test_writer.py` | 新增 2 个风格注入测试 |

---

## 五、不在本次范围内

- 风格对写作结果的 A/B 评估
- 用户自定义风格的持久化保存
- 风格影响 ReviewAgent 的评审标准
