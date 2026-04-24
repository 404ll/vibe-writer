# vibe-writer Phase 3 设计文档：ReviewAgent + UI 重设计

**日期：** 2026-04-24
**状态：** 待实现

---

## 目标

1. 引入 `ReviewAgent`：轻审（每章连贯性 + 内容完整度）+ 重审（全文质量），不通过时自动重写一次
2. 重设计前端 UI：浅色科技感（Linear/Vercel 风格），新增 `ActivityPanel` 实时展示搜索/审稿进度，修复现有无障碍问题

---

## 一、后端：ReviewAgent

### 1.1 数据结构

```python
# backend/agent/reviewer.py

@dataclass
class ReviewResult:
    passed: bool
    feedback: str   # 不通过时的具体意见；通过时为空字符串
```

### 1.2 接口

```python
class ReviewAgent(BaseAgent):
    async def review_chapter(
        self,
        chapter_title: str,
        content: str,
        outline: str,       # 完整大纲文本，用于判断连贯性
    ) -> ReviewResult:
        """轻审：连贯性 + 内容完整度"""

    async def review_full(
        self,
        topic: str,
        chapters: list[dict],   # [{"title": str, "content": str}]
    ) -> list[ReviewResult]:
        """重审：全文整体质量"""
```

### 1.3 LLM 输出格式

固定文本格式，用 `startswith` 解析，不依赖 JSON：

```
PASSED
```
或
```
FAILED
理由：xxx
建议：xxx
```

### 1.4 Prompts（新增到 prompts.py）

**轻审 prompt：**
- System：你是技术博客审稿人，检查单章的连贯性和内容完整度
- 检查项：① 与大纲其他章节是否衔接自然；② 章节标题是否被充分展开（300字以上，有实质内容）
- 输出格式：PASSED 或 FAILED + 理由 + 建议

**重审 prompt：**
- System：你是技术博客审稿人，检查全文整体质量
- 检查项：① 整体可读性；② 技术准确性；③ 章节间逻辑连贯
- 对每章分别输出：`章节N: PASSED` 或 `章节N: FAILED\n理由：...\n建议：...`

### 1.5 重审输出解析

重审返回多章结果，格式：
```
章节1: PASSED
章节2: FAILED
理由：内容过于简单
建议：补充实际代码示例
章节3: PASSED
```

按 `章节N:` 分割，逐段解析。

---

## 二、后端：Orchestrator 修改

### 2.1 新增 StageStatus

```python
class StageStatus(str, Enum):
    PLAN = "plan"
    WRITE = "write"
    REVIEW = "review"    # 新增
    EXPORT = "export"
    DONE = "done"
    ERROR = "error"
```

### 2.2 新增 SSE 事件

| 事件 | 触发时机 | data 字段 |
|------|----------|-----------|
| `reviewing_chapter` | 每章轻审开始前 | `{title: str}` |
| `chapter_done` | 每章完成（含审稿结果） | `{title, index, review: {passed, feedback}}` |
| `reviewing_full` | 重审开始前 | `{}` |
| `review_done` | 重审完成 | `{results: [{title, passed, feedback}]}` |

`chapter_done` 扩展 `review` 字段（向后兼容：前端检查字段是否存在）。

### 2.3 WRITE 阶段修改（每章）

```
for chapter_title in chapters:
    # 搜索
    push searching SSE
    research = SearchAgent.search()

    # 写作
    content = WriterAgent.write()

    # 轻审
    push reviewing_chapter SSE
    result = ReviewAgent.review_chapter(chapter_title, content, outline_text)
    if not result.passed:
        # 重写一次，把 feedback 注入 prompt
        content = WriterAgent.write(... + review_feedback=result.feedback)

    written_chapters.append(...)
    push chapter_done SSE (带 review 字段)

    if intervention_on_chapter:
        wait_for_reply()
```

### 2.4 新增 REVIEW 阶段（WRITE 之后，EXPORT 之前）

```
# 重审
job.stage = REVIEW
push stage_update SSE
push reviewing_full SSE

results = ReviewAgent.review_full(topic, written_chapters)
for result in results (failed only):
    chapter = find chapter by title
    new_content = WriterAgent.write(... + review_feedback=result.feedback)
    update written_chapters

push review_done SSE (带全部结果)
```

### 2.5 WriterAgent 接口扩展

`write()` 新增可选参数 `review_feedback: str = ""`：
- 为空时：prompt 不变
- 非空时：prompt 末尾追加 `\n\n审稿意见：{feedback}\n请根据以上意见修改章节内容。`

---

## 三、前端：UI 重设计

### 3.1 设计语言

- **背景**：`#ffffff` 主背景，`#f8fafc` 次级背景（卡片）
- **强调色**：电蓝 `#2563eb`（primary），青绿 `#0891b2`（secondary）
- **边框**：`1px solid #e2e8f0`（细线）
- **阴影**：`0 1px 3px rgba(0,0,0,0.08)`（轻阴影）
- **字体**：标题用 `'SF Mono', 'Fira Code', monospace`，正文用系统 sans-serif
- **圆角**：`6px`（卡片），`4px`（按钮/标签）
- **状态色**：成功 `#16a34a`，失败 `#dc2626`，进行中 `#2563eb`，待处理 `#94a3b8`

### 3.2 布局

```
┌─────────────────────────────────────────┐
│  vibe-writer              [monospace标题] │
├─────────────────────────────────────────┤
│  InputPanel                              │
│  [主题输入框 ──────────────] [开始写作]  │
│  ☑ 大纲后介入  ☐ 每章后介入             │
├─────────────────────────────────────────┤
│  StagePanel                              │
│  ● 规划大纲 ──→ ● 撰写章节 ──→ ● 审稿 ──→ ● 导出  │
├─────────────────────────────────────────┤
│  ReviewPanel（大纲确认，仅需要时显示）   │
├─────────────────────────────────────────┤
│  ActivityPanel（实时日志）               │
│  ↳ 搜索中：什么是 Agent...              │
│  ✓ 轻审通过：什么是 Agent               │
│  ✗ 轻审未通过：核心组件 → 重写中...     │
│  ✓ 全文审稿通过                         │
└─────────────────────────────────────────┘
```

### 3.3 组件变更

**InputPanel（修改）：**
- 输入框加 `aria-label="写作主题"` + `type="text"` + `autocomplete="off"`
- 按钮加 `aria-label` + focus-visible 样式
- checkbox 用 `<label>` 包裹，确保可点击区域

**StagePanel（修改）：**
- 新增 `review` 阶段（在 write 和 export 之间）
- 横向步进条样式（带连接线）
- 添加 `aria-live="polite"` + `role="status"`
- 当前阶段：电蓝实心圆 + 发光 `box-shadow`
- 完成阶段：绿色 ✓
- 待处理：灰色空心圆

**ReviewPanel（修改）：**
- 卡片样式（白底 + 蓝色左边框）
- `<textarea>` 加 `aria-label`
- 按钮改为实心电蓝色

**ActivityPanel（新增）：**
- 固定高度 `240px`，`overflow-y: auto`，自动滚动到底部
- 每条日志一行，前缀图标：
  - `⟳` 进行中（旋转动画，`prefers-reduced-motion` 时静止）
  - `✓` 成功（绿色）
  - `✗` 失败/重写（红色）
  - `→` 信息（蓝色）
- 响应 SSE 事件：`searching`、`chapter_done`（含 review）、`reviewing_chapter`、`reviewing_full`、`review_done`、`done`

**App.tsx（修改）：**
- 新增 `activityLog: ActivityEntry[]` 状态
- 处理新 SSE 事件：`reviewing_chapter`、`review_done`
- `chapter_done` 处理扩展：读取 `data.review` 字段
- 新增 `StageStatus.REVIEW` 的 `stage_update` 处理

### 3.4 TypeScript 类型扩展（types.ts）

```typescript
export type StageStatus = "plan" | "write" | "review" | "export" | "done" | "error"

export type SSEEventType =
  | "stage_update"
  | "outline_ready"
  | "searching"
  | "reviewing_chapter"
  | "chapter_done"
  | "reviewing_full"
  | "review_done"
  | "done"
  | "error"

export interface ReviewResult {
  passed: boolean
  feedback: string
}

export interface ActivityEntry {
  id: number
  status: "running" | "success" | "failed" | "info"
  message: string
}
```

---

## 四、无障碍修复（对照 Web Interface Guidelines）

| 问题 | 位置 | 修复方案 |
|------|------|----------|
| `<input>` 无 label | InputPanel | 加 `aria-label="写作主题"` |
| `<input>` 无 type | InputPanel | 加 `type="text"` |
| `<textarea>` 无 label | ReviewPanel | 加 `aria-label="修改意见"` |
| 状态变化无通知 | StagePanel | 加 `aria-live="polite"` |
| 错误无 role | App.tsx | 加 `role="alert"` |
| 按钮无 focus 样式 | 全局 | 加 `:focus-visible` outline |

---

## 五、文件变更清单

### 后端（新建/修改）

| 文件 | 变更 |
|------|------|
| `backend/agent/reviewer.py` | 新建：ReviewAgent + ReviewResult |
| `backend/agent/prompts.py` | 修改：新增 CHAPTER_REVIEW_SYSTEM/USER、FULL_REVIEW_SYSTEM/USER |
| `backend/agent/writer.py` | 修改：`write()` 新增 `review_feedback` 参数 |
| `backend/agent/orchestrator.py` | 修改：接入 ReviewAgent，新增 REVIEW 阶段 |
| `backend/models.py` | 修改：StageStatus 新增 REVIEW |
| `tests/test_reviewer.py` | 新建 |
| `tests/test_writer.py` | 修改：补充 review_feedback 测试 |
| `tests/test_orchestrator.py` | 修改：mock ReviewAgent，验证新事件 |

### 前端（修改）

| 文件 | 变更 |
|------|------|
| `frontend/src/types.ts` | 新增 ReviewResult、ActivityEntry，扩展 SSEEventType、StageStatus |
| `frontend/src/components/InputPanel.tsx` | 无障碍修复 + 样式重设计 |
| `frontend/src/components/StagePanel.tsx` | 新增 review 阶段 + 步进条样式 + aria |
| `frontend/src/components/ReviewPanel.tsx` | 无障碍修复 + 样式重设计 |
| `frontend/src/components/ActivityPanel.tsx` | 新建：实时活动日志 |
| `frontend/src/App.tsx` | 新增状态、处理新 SSE 事件、接入 ActivityPanel |
| `frontend/src/index.css` 或 `App.css` | 全局样式：字体、颜色变量、focus-visible |

---

## 六、不在本次范围内

- Phase 4：配图 agent（DALL-E）
- Phase 5：断点续写、章节重试
- 前端搜索结果展示（仅在 ActivityPanel 显示"搜索中"状态）
- 审稿反馈的用户编辑（用户不能修改审稿意见，只能看）
