# vibe-writer Phase 2 设计文档：多 Agent 架构 + Tavily 搜索

## 目标

将现有单体 Orchestrator 拆分为多 Agent 协作架构，引入 SearchAgent（Tavily 搜索 + LLM 提炼）和 WriterAgent（章节写作），Orchestrator 退化为纯协调者。每章写作前先搜索相关资料，经 LLM 提炼后注入写作 prompt，提升内容质量。

---

## 背景：现状

Phase 1 的 Orchestrator 是单体结构，所有逻辑（规划、写作、导出）都在 `orchestrator.py` 的 `run()` 方法里。这在 Phase 1 够用，但随着功能增加（搜索、配图、审稿）会变得难以维护。

---

## Agent 职责划分

```
Orchestrator（协调者）
    ├── PlannerAgent     → 调用 LLM 生成大纲，解析章节列表
    ├── SearchAgent      → 搜索章节关键词 + LLM 提炼参考资料
    └── WriterAgent      → 根据章节标题 + 参考资料写正文
```

### PlannerAgent
- 输入：topic（主题）
- 输出：`list[str]`（章节标题列表）
- 职责：调用 LLM 生成大纲，解析编号列表

### SearchAgent
- 输入：query（查询词，通常是章节标题）
- 输出：`str`（提炼后的参考资料，200 字以内）
- 职责：
  1. 调用 Tavily API 搜索，取前 3 条结果
  2. 调用 LLM 把搜索摘要提炼成结构化参考资料
- 如果搜索失败（网络错误、Key 无效），返回空字符串，写作继续（降级处理）

### WriterAgent
- 输入：topic、outline、chapter_title、research（参考资料）
- 输出：`str`（章节正文 Markdown）
- 职责：调用 LLM 写章节正文，research 为空时正常写作（不依赖搜索）

### Orchestrator（重构后）
- 职责：调度三个 Agent，管理阶段状态，推送 SSE 事件
- 不再包含任何 LLM 调用逻辑，只做编排

---

## 数据流

```
PLAN 阶段：
  Orchestrator → PlannerAgent.plan(topic) → chapters: list[str]

WRITE 阶段（每章）：
  Orchestrator → SearchAgent.search(chapter_title) → research: str
               → WriterAgent.write(topic, outline, chapter_title, research) → content: str

EXPORT 阶段：
  Orchestrator → 拼接 Markdown → 写文件
```

---

## SSE 事件变更

新增 `searching` 事件，在每章搜索开始时推送：

```json
{ "event": "searching", "data": { "title": "章节标题" } }
```

前端收到后可在 StagePanel 显示"搜索中..."状态（Phase 4 UI 优化时处理，Phase 2 后端推送即可）。

---

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `backend/agent/planner.py` | 新建 | PlannerAgent |
| `backend/agent/search.py` | 新建 | SearchAgent（Tavily + LLM 提炼） |
| `backend/agent/writer.py` | 新建 | WriterAgent |
| `backend/agent/orchestrator.py` | 重构 | 退化为协调者，委托给三个 Agent |
| `backend/agent/prompts.py` | 修改 | 新增 RESEARCH_SYSTEM/USER、CHAPTER_USER 增加 research 字段 |
| `backend/models.py` | 修改 | SSEEvent 支持 `searching` 事件 |
| `backend/requirements.txt` | 修改 | 添加 `tavily-python==0.3.3` |
| `.env` | 修改 | 添加 `TAVILY_API_KEY` |
| `tests/test_planner.py` | 新建 | PlannerAgent 单测 |
| `tests/test_search.py` | 新建 | SearchAgent 单测（mock Tavily + mock LLM） |
| `tests/test_writer.py` | 新建 | WriterAgent 单测（mock LLM） |
| `tests/test_orchestrator.py` | 修改 | 更新为 mock 三个 Agent |

---

## 错误处理

- **Tavily 搜索失败**：SearchAgent 捕获异常，返回空字符串 `""`，WriterAgent 收到空 research 时正常写作
- **LLM 提炼失败**：同上，降级为空字符串
- **WriterAgent 失败**：向上抛出，Orchestrator 捕获，推送 error 事件

---

## 不在本次范围内

- 前端展示搜索结果或来源链接（Phase 4）
- 章节并行搜索（Phase 4 性能优化）
- 配图生成（Phase 3）
