# vibe-writer

输入一个主题，AI 自动完成搜索、写作、审稿，生成一篇完整的技术博客。

---

## 快速启动

**环境要求：** Python 3.11+，Node.js 18+

```bash
# 1. 配置环境变量
cp .env.example .env   # 填入 ANTHROPIC_API_KEY / TAVILY_API_KEY / MODEL_ID

# 2. 启动后端
python3 -m pip install -r requirements.txt
python3 -m uvicorn backend.main:app --reload   # http://localhost:8000

# 3. 启动前端
cd frontend && npm install && npm run dev       # http://localhost:5173

# 4. 运行测试
python3 -m pytest
```

---

## 架构概览

```
浏览器 (React + TypeScript)
    │  POST /jobs          创建任务
    │  GET  /jobs/stream   SSE 实时进度
    │  POST /jobs/reply    大纲确认
    ▼
FastAPI + asyncio
    └── Orchestrator（流水线调度）
            ├── PlannerAgent    生成大纲
            ├── OpinionAgent    生成章节论点 + 搜索方向
            ├── WriterAgent ←── SearchAgent.search_one（注入）
            └── ReviewAgent     轻审（每章）+ 全文重审
                    ↓
            SQLite（文章持久化）
            JobStore（任务状态，内存）
```

---

## Agent 设计

### 流水线结构

```
PLAN  →  WRITE（各章并行）  →  REVIEW  →  EXPORT
              ↓
    OpinionAgent（论点 + 搜索方向）
              ↓
    WriterAgent（ReAct loop：按需自主搜索）
              ↓
    ReviewAgent（轻审，不通过重写一次）
```

### WriterAgent：从流水线到自主 Agent

项目经历了一次核心架构演进：

**早期（Pipeline 模式）**
```
Orchestrator 决定：先搜索 → 把结果喂给 Writer
Writer 被动接收 research，一次性生成内容
```

**现在（Agentic 模式）**
```
Writer 自主决定：写到哪里需要什么资料，主动调用 search 工具
基于 ReAct loop：LLM → tool_use → 执行搜索 → 继续生成
```

核心实现在 `BaseAgent._call_llm_with_tools()`：

```python
# 来自 s01/s02 的 agent loop pattern
while stop_reason == "tool_use":
    response = LLM(messages, tools)
    messages.append(assistant turn)
    execute tools → collect results
    messages.append(tool_results)
return final text
```

Writer 声明 `search` 工具，LLM 在需要具体数据或案例时主动调用，搜索结果作为 `tool_result` 反馈，LLM 继续写作直到 `stop_reason == "end_turn"`。

### 依赖注入：解耦搜索实现

`WriterAgent` 不直接持有 `SearchAgent`，而是接收一个函数签名：

```python
WriterAgent(search_fn: async (query: str) -> str)
```

好处：将来换搜索引擎（Tavily → Bing → 自建），只需换注入的函数，Writer 代码不动。

### OpinionAgent：论点驱动的搜索方向

`OpinionAgent` 为每个章节生成 2-3 个核心论点，同时输出搜索方向建议。论点作为写作骨架传给 Writer，搜索方向作为 `search_hints` 附加到 prompt——Writer 可以参考，也可以自行判断搜别的，不是强制约束。

这体现了"宏观方向（Opinion）+ 微观自主（Writer tool_use）"的分层设计。

### ReviewAgent：两轮收敛机制

- **轻审**：每章写完后立即审（连贯性 + 完整度），不通过则重写一次，再审一次
- **全文重审**：所有章节完成后整体审，不通过的章节并行重写，最多两轮

两轮机制保证了质量收敛，同时避免无限循环。

---

## 实时通信设计

前端通过 **SSE（Server-Sent Events）** 订阅任务进度：

```
POST /jobs          → 返回 job_id，后台启动 asyncio.create_task
GET  /stream        → 长连接，实时接收事件
POST /reply         → 用户确认大纲，唤醒挂起的 Orchestrator
```

大纲确认的实现用了 `asyncio.Event`：Orchestrator 在介入节点 `await event.wait()` 挂起，前端 POST `/reply` 后调用 `event.set()` 唤醒。这是经典的**协程间同步**模式。

SSE 历史事件存储支持断线重连回放：前端重连时先 `GET /events` 拉取历史，再接 `/stream` 接收新事件。

---

## 技术选型

| 技术 | 用途 | 选型理由 |
|------|------|----------|
| Anthropic SDK | LLM 调用 | 兼容 Kimi/DeepSeek 等国内模型的 API 格式 |
| Tavily API | 实时搜索 | 专为 LLM 设计，返回结构化摘要 |
| FastAPI + asyncio | 后端 | 原生异步，SSE 支持好，与 asyncio Agent 天然契合 |
| SQLite + aiosqlite | 持久化 | 零配置，异步驱动，适合单机部署 |
| React + TypeScript | 前端 | 类型安全，组件化实时状态管理 |

---

## 已知局限与未来方向

### 当前局限

| 问题 | 影响 |
|------|------|
| JobStore 纯内存 | 服务重启任务丢失，无断点续写 |
| tool_use 期间无流式输出 | 搜索时前端无 token 流，有停顿感 |
| 全文审稿一次性塞入 prompt | 章节多时有 token 溢出风险 |

### 未来方向

**中期**
- **持久化 JobStore**：复用已有 SQLite，让任务状态跨重启存活，解锁断点续写
- **全文审稿分批**：超过阈值后改为逐章审，防止 token 溢出

**长期**
- **图结构化**：用 LangGraph 或自实现状态图，让 review 失败时真正循环重写，而不是固定两轮
- **多模型路由**：根据任务类型（规划/写作/审稿）动态选择不同模型，平衡质量与成本

---

## 项目结构

```
backend/
├── agent/
│   ├── base.py          BaseAgent + _call_llm_with_tools（ReAct loop）
│   ├── orchestrator.py  流水线调度
│   ├── planner.py       大纲生成
│   ├── opinion.py       论点 + 搜索方向
│   ├── writer.py        自主写作 Agent
│   ├── search.py        Tavily 搜索 + LLM 提炼
│   ├── reviewer.py      轻审 + 全文审
│   └── prompts.py       所有 prompt 模板
├── routers/
│   ├── jobs.py          任务 API + SSE
│   └── articles.py      文章 CRUD
├── store.py             内存 JobStore
├── database.py          SQLite 初始化
└── models.py / models_db.py
frontend/
├── src/
│   ├── components/      InputPanel / StagePanel / ReviewPanel
│   ├── hooks/           useJobStream（SSE 订阅）
│   └── types.ts
tests/                   pytest 单元测试
```
