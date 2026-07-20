# vibe-writer

一个基于 React、FastAPI 和 LangGraph 的 AI 长文写作工作台。用户提交主题后，系统会生成大纲（可选人工确认），并行完成章节论点、按需资料搜索、写作和审稿，最后导出 Markdown，并提供文章编辑、历史版本与 Mermaid 图表渲染。

> 当前实现快照：2026-07。本文以仓库现有代码为准，明确区分已经实现的能力和尚未完成的方向。

## 核心能力

- LangGraph `plan → write → review → export` 工作流，审稿不通过时通过条件边回到写作阶段。
- Planner、Opinion、Writer、Search、Reviewer 分阶段协作；Writer 可自主调用搜索和 Mermaid 图表工具。
- 大纲确认支持人工介入：用户可以编辑大纲、提交修改意见或确认继续。
- 多章节通过 `asyncio.gather()` 并行处理，前端实时展示各章节状态。
- SSE 任务事件流，支持半包解析、历史回放、`_seq` 去重、自动重连和取消。
- 生成结果同时写入后端工作目录下的 `output/*.md` 和 SQLite；文章支持编辑、历史快照、预览和恢复。

## 快速启动

环境要求：

- Python 3.11+
- Node.js `^20.19.0` 或 `>=22.12.0`（Vite 8 的运行要求）
- pnpm 10

```bash
# 1. 配置环境变量
cp .env.example .env
# 必填：ANTHROPIC_API_KEY
# 可选：TAVILY_API_KEY、ANTHROPIC_BASE_URL、MODEL_ID、DATABASE_URL

# 2. 安装前端 workspace 依赖
pnpm install

# 3. 创建后端虚拟环境并安装依赖
python3 -m venv .venv
source .venv/bin/activate
pip install -r apps/api/requirements.txt

# 4. 启动后端
cd apps/api
../../.venv/bin/python -m uvicorn backend.main:app --reload
# http://localhost:8000

# 5. 另开终端，从仓库根目录启动前端
pnpm dev:web
# http://localhost:5173
```

开发环境中，前端请求 `/api/*`，Vite 将其代理到 `http://127.0.0.1:8000` 并移除 `/api` 前缀。

`MODEL_ID` 默认是 `deepseek-v4-flash`。如果使用 Anthropic 官方服务或其他兼容服务，需要确保 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 和 `MODEL_ID` 属于同一服务商并且模型可用。没有 `TAVILY_API_KEY` 时项目仍能写作，但搜索工具会返回“搜索不可用”并跳过真实检索。

### 验证命令

```bash
pnpm test:web
pnpm build:web
pnpm lint:web
pnpm test:api
pnpm verify
```

当前已知状态：

- `pnpm test:web`、`pnpm build:web` 可通过。
- `pnpm lint:web` 存在既有 lint 错误。
- `pnpm test:api` 存在既有 Agent/LLM mock 相关失败。
- `pnpm verify` 通过 `&&` 串联 API 测试、前端 lint 和前端 build；当前会在 API 测试失败后停止，不能作为全绿验证入口。

## 架构概览

```text
浏览器（React + TypeScript）
    │
    ├── POST /jobs                  创建任务，获取 job_id
    ├── GET  /jobs/{id}/stream      SSE 实时事件流
    ├── GET  /jobs/{id}/events      历史事件回放
    ├── POST /jobs/{id}/reply       确认或修改大纲
    └── POST /jobs/{id}/cancel      取消任务
            │
            ▼
FastAPI + asyncio
    ├── asyncio.create_task(_run_agent)
    ├── JobStore
    │   ├── job 元数据、人工回复和取消标志
    │   └── SSE 事件历史（进程内存）
    └── LangGraph StateGraph
        ├── plan    → PlannerAgent
        ├── write   → OpinionAgent + WriterAgent + SearchAgent
        ├── review  → ReviewAgent
        └── export  → Markdown + SQLite Article
                           │
                           ▼
                    文章阅读 / 编辑 / 版本恢复
```

前端负责交互、SSE 消费和 UI 状态；后端负责 LangGraph 编排、LLM/tool loop、任务事件和文章持久化。它是一个分阶段的 LangGraph 写作工作流，不是多个自治 Agent 相互协商的系统。

## LangGraph 工作流

图中只有四个节点：`plan`、`write`、`review`、`export`。

```text
START
  ↓
PLAN ── 生成大纲，可等待用户确认或修改
  ↓
WRITE ── 各章节并行生成论点、按需搜索、写作和轻审
  ↓
REVIEW ── 全文审稿
  ├── 存在未通过章节且未达到上限 ──→ WRITE
  └── 全部通过或达到重审上限 ─────→ EXPORT
                                         ↓
                                        END
```

LangGraph 的 `WriterState` 保存主题、风格、目标字数、大纲、章节、重审次数和最终内容。`should_rewrite()` 是 review 之后唯一的决策点：第一次全文审稿未通过的章节会回到 write，已通过章节会跳过；第二次全文审稿后无论是否全部通过都会进入 export。

章节级轻审是另一层规则：每次进入 write 的章节完成本轮写作后都会轻审；如果不通过，会携带反馈立即重写一次，但这次立即重写的结果不会再次执行轻审。

### 各组件职责

| 组件 | 职责 |
|---|---|
| `PlannerAgent` | 根据主题和目标字数生成大纲；根据用户反馈修订大纲 |
| `OpinionAgent` | 为每章生成核心论点和搜索方向 |
| `SearchAgent` | 调用 Tavily 搜索并整理资料 |
| `WriterAgent` | 根据大纲、论点和审稿反馈写作；自主调用 `search`、`generate_diagram` 工具 |
| `ReviewAgent` | 章节轻审和全文审稿，返回结构化通过状态与反馈 |

### Writer tool loop

`BaseAgent._call_llm_with_tools()` 统一实现最多 8 轮的工具调用循环：

```text
LLM 响应
  ├── stop_reason == tool_use
  │      ↓
  │   执行 search / generate_diagram
  │      ↓
  │   将 tool_result 追加到 messages，再次调用 LLM
  │
  └── 其他 stop_reason → 提取最终文本
```

`WriterAgent` 不直接依赖 `SearchAgent`，而是接收异步 `search_fn`。写作节点在注入的搜索函数外包装 `searching` / `search_done` 事件和每轮最多 3 次搜索的限制。

### 人工确认大纲

启用 `intervention.on_outline` 后，plan 节点推送 `outline_ready` 并等待 `JobStore.wait_for_reply()`：

```text
outline_ready ──SSE──→ 前端 ReviewPanel
                            │
                            └── POST /jobs/{id}/reply
                                      │
                                      └── asyncio.Event.set()
                                                │
                                                └── 唤醒 plan 节点
```

SSE 只负责服务端到浏览器的单向通知；用户确认、修改和取消均通过普通 HTTP POST 返回后端。

## SSE 实时通信

### 端到端数据流

```text
LangGraph 节点产生 SSEEvent
    ↓
push_event() 添加递增 _seq
    ↓
先写入 JobStore._event_logs
    ↓
广播到每个订阅者的 asyncio.Queue
    ↓
StreamingResponse 编码为 event/data 文本帧
    ↓
fetch + ReadableStream + TextDecoder
    ↓
buffer 按空行切分完整 SSE frame
    ↓
按 _seq 去重并移除 _seq
    ↓
App.handleEvent 更新阶段、日志、章节状态和写作预览
```

后端发送的单个帧形如：

```text
event: writing_chapter
data: {"title":"第一章","token":"...","_seq":7}

```

前端当前没有使用 `EventSource`，而是由 `useJobStream` 通过 `fetch` 读取 `Response.body`，自行处理：

- UTF-8 字符和 SSE frame 跨多个 `ReadableStream` chunk 的情况；
- `event:` / 多行 `data:` 字段解析和事件白名单；
- `AbortController` 清理旧连接；
- 连接异常结束后等待 1 秒重连；
- `done`、`cancelled`、`error` 三类终止事件。

### 历史回放与去重

任务创建后可能在浏览器订阅前就产生事件，因此 `push_event()` 总是先写历史、再广播。前端重连采用：

```text
1. 先连接 /stream，尽早加入实时订阅
2. 再请求 /events，回放当前后端进程保存的历史
3. 实时流中与历史重叠的事件通过 _seq 去重
```

页面刷新时，前端从 `localStorage` 恢复 `job_id`，再通过历史事件重建 UI。这里恢复的是同一个后端进程中的事件状态；`JobStore` 和事件历史没有持久化，服务重启后不能恢复任务。

后端重启后，旧 job 的 `/stream` 和 `/events` 会返回 404；当前前端没有专门的“任务已失效”状态，可能继续保留旧 `job_id` 并尝试重连。

### 当前正文流式边界

SSE 连接和任务事件是真正实时的，但章节正文当前不是模型逐 token 输出。`WriterAgent.write_stream()` 会先等待完整 tool loop 结束，再一次性 `yield` 整章文本，因此通常一个写作轮次只产生一次 `writing_chapter` 正文事件。`BaseAgent._stream_llm()` 虽然存在，目前没有接入 Writer 的工具调用流程。

## 文章持久化与编辑

export 节点会：

1. 拼接所有章节为 Markdown；
2. 写入后端进程当前工作目录下的 `output/<slug>.md`；
3. 保存到 SQLite `articles` 表（默认数据库同样相对于后端工作目录）；
4. 通过 `done` 事件返回 `article_id`，前端跳转到文章详情页。

按本文推荐命令从 `apps/api` 启动时，生成文件位于 `apps/api/output/`，默认数据库位于 `apps/api/data/vibe_writer.db`。

文章详情页支持：

- Markdown + GFM 阅读；
- Mermaid 代码块渲染；
- 左侧预览、右侧 Markdown 的编辑模式；
- 保存前自动创建 `ArticleVersion` 快照；
- 查看历史版本并恢复。

## API

### Jobs

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/jobs` | 创建后台写作任务，返回 `job_id` |
| `GET` | `/jobs/{job_id}/stream` | 建立 `text/event-stream` 长连接 |
| `GET` | `/jobs/{job_id}/events` | 获取进程内历史事件 |
| `POST` | `/jobs/{job_id}/reply` | 提交大纲确认、编辑结果或修改建议 |
| `POST` | `/jobs/{job_id}/cancel` | 取消后台 asyncio Task |

### Articles

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/articles` | 获取文章列表 |
| `GET` | `/articles/{article_id}` | 获取文章全文 |
| `PATCH` | `/articles/{article_id}` | 保存编辑并创建旧内容快照 |
| `GET` | `/articles/{article_id}/versions` | 获取历史版本列表 |
| `GET` | `/articles/{article_id}/versions/{version_id}` | 获取历史版本内容 |
| `POST` | `/articles/{article_id}/versions/{version_id}/restore` | 恢复历史版本 |

## 技术栈

| 层 | 技术 | 当前用途 |
|---|---|---|
| 前端 | React 19、TypeScript、Vite 8 | 工作台、任务状态、文章阅读与编辑 |
| 实时通信 | SSE、Fetch、ReadableStream | 进度事件、回放、去重和重连 |
| 后端 | FastAPI、asyncio、Pydantic | HTTP API、后台任务和事件流 |
| 工作流 | LangGraph | `plan → write → review → export` 和条件重写 |
| LLM | Anthropic Python SDK | 普通调用、JSON 解析和 tool loop；支持配置兼容 base URL 与模型 ID |
| 搜索 | Tavily | Writer 按需搜索资料 |
| 数据 | SQLAlchemy async、aiosqlite | 文章和历史版本持久化 |
| 内容 | react-markdown、remark-gfm、Mermaid | Markdown/GFM/图表渲染 |
| 测试 | pytest、pytest-asyncio、Vitest | 后端和前端单元测试 |

## 项目结构

```text
apps/
├── api/
│   ├── backend/
│   │   ├── agent/
│   │   │   ├── graph.py          LangGraph 节点、边和条件重写
│   │   │   ├── base.py           LLM、JSON 和 tool loop 基类
│   │   │   ├── planner.py        大纲规划
│   │   │   ├── opinion.py        章节论点和搜索方向
│   │   │   ├── search.py         Tavily 搜索
│   │   │   ├── writer.py         写作、搜索和 Mermaid 工具
│   │   │   └── reviewer.py       章节与全文审稿
│   │   ├── routers/
│   │   │   ├── jobs.py           Job、SSE、回放、回复和取消 API
│   │   │   └── articles.py       文章和版本 API
│   │   ├── database.py           SQLite async 初始化
│   │   ├── models.py             API 与 LangGraph 状态模型
│   │   ├── models_db.py          Article / ArticleVersion ORM
│   │   └── store.py              进程内 JobStore
│   ├── tests/                     pytest 测试
│   ├── output/                    推荐启动方式下生成的 Markdown（不提交）
│   ├── data/                      推荐启动方式下的本地 SQLite（不提交）
│   └── requirements.txt
└── web/
    ├── src/
    │   ├── App.tsx               任务 UI 状态和事件消费
    │   ├── api.ts                文章 API client
    │   ├── sseEvents.ts          SSE 事件协议与分组
    │   ├── hooks/useJobStream.ts SSE 连接、解析、回放和重连
    │   ├── components/           工作台组件
    │   └── pages/ArticlePage.tsx 文章阅读、编辑和历史版本
    ├── vite.config.ts             开发代理和 Vitest 配置
    └── package.json               @vibe-writer/web workspace

docs/                              架构、评估、设计和任务记录
package.json                       根级 pnpm 命令
pnpm-workspace.yaml                workspace 配置
```

`output/` 相对于后端进程工作目录。默认 `DATABASE_URL` 也是相对路径，但初始化代码只会自动创建 `apps/api/data/`；如果不按本文推荐方式启动，需要自行创建数据库父目录或显式设置 `DATABASE_URL`。

## 已知局限与下一步

| 当前局限 | 影响 | 对应方向 |
|---|---|---|
| JobStore、事件历史和运行中任务只在单进程内存中 | 后端重启或多 worker 部署时无法恢复/共享任务 | 将 job、event log 和 LangGraph checkpoint 持久化 |
| Writer 完成 tool loop 后才一次性发送正文 | 搜索和生成期间正文预览可能长时间没有更新 | 设计兼容工具调用的真正 token streaming |
| 历史回放遇到终止事件不会像实时帧一样主动结束连接循环 | 已完成任务的刷新恢复可能留下等待中的流连接 | 统一实时事件与回放事件的终态处理 |
| SSE 没有 heartbeat，订阅队列无上限，历史日志不淘汰 | 长空闲连接可能被代理关闭，慢消费者或长任务可能增加内存 | 增加心跳、背压、历史游标和清理策略 |
| 全文审稿一次性接收所有章节 | 超长文章可能触及模型上下文上限 | 按章节或分批审稿，再汇总全局结果 |
| 审稿 JSON 解析失败时默认通过 | 模型输出格式异常可能绕过质量检查 | 引入严格 schema、有限重试和显式失败状态 |
| 恢复历史版本前不会保存当前内容，恢复后还会重复保存被恢复内容 | 当前版本会被直接覆盖，无法撤销本次恢复 | 恢复前先快照当前内容，并明确版本链语义 |
| 生产环境 API 地址仍默认 `http://localhost:8000` | 部署到非本机环境时需要修改配置 | 改为构建时环境变量和同源反向代理 |

## 演进记录

### v1：顺序流水线

早期由 `Orchestrator` 通过 Python 控制流串联规划、搜索、写作和导出，状态和基础设施耦合较重。

### v2：LangGraph 工作流

- 删除旧 `Orchestrator`，改为 `StateGraph(WriterState)`。
- 建立 `plan → write → review → export` 节点和 review 条件边。
- 通过闭包注入 agent、`job_id`、SSE 推送、人工回复和取消函数。
- 当前运行入口为 `graph.ainvoke(initial_state)`；尚未接入持久化 checkpointer。

详细思考过程：[我把自己写的 AI 写作 Agent 重构了一遍](https://elemen-in-here.vercel.app/blog/frontend/vibe-writer-langgraph)

### v3：文章编辑、版本与 Mermaid

- 增加文章编辑态和历史版本快照。
- 增加 `generate_diagram` tool，由 Writer 判断是否生成 Mermaid 图表。
- 阅读态和编辑预览均支持 Mermaid 渲染。

### 当前：可恢复的 SSE 前端传输层

- 前端从 `EventSource` 迁移到 `fetch + ReadableStream`。
- 增加跨 chunk 的 SSE frame 缓冲解析、`AbortController` 生命周期管理和自动重连。
- `push_event()` 为事件增加 `_seq`，先写历史、再广播；前端通过 `/events` 回放并去重。
- 刷新恢复范围明确为同一后端进程，不宣称服务重启后的持久恢复。
