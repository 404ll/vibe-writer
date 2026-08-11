# Iteration 0005：Agent Core 与 Planner/Reviewer 迁移

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R4 TS Agent core
- 对应决策：[ADR-0004](../decisions/0004-evaluation-first-migration.md)、[ADR-0006](../decisions/0006-agent-core-model-port-and-invalid-output.md)

## 目标

建立不依赖 HTTP、队列、数据库和供应商 SDK 的 TypeScript Agent 核心边界，迁移 Planner 与 Reviewer 的首批确定性规则和模型调用，并用共享 fixture 同时约束 Python compatibility baseline 与 TypeScript target behavior。

## 范围内

- 新增 `packages/model-runtime`，定义 text model port、统一响应、usage 和结构化错误；
- 新增 `packages/agent-core`，迁移 Planner/Reviewer、相关 prompt builder 和版本常量；
- 建立 Planner outline parsing/trim、JSON tolerance、Reviewer budget 与 invalid-output fixture；
- Python 与 TypeScript 测试读取同一 fixture；
- 修正 Python Agent 测试 double，使其模拟真实 `type="text"` content block；
- 增加根级 agent/model test 与 typecheck 命令；
- 记录 compatibility 与 target 语义差异。

## 范围外

- 不迁移 Opinion、Search、Writer/tool loop、export 或完整图；
- 不安装或组装 LangGraph.js；
- 不实现 Anthropic/LangChain provider adapter，不发真实模型请求；
- 不接入 PostgreSQL、Worker、Next.js API、SSE 或队列；
- 不宣称 Planner/Reviewer 已切流；
- 不做主观文章质量 LLM-as-a-Judge。

## 必须证明的行为

1. Agent core 不导入 Next.js、LangGraph、数据库或 provider SDK；
2. Planner 保持编号解析和按总字数裁剪章节数的基线行为；
3. 每次模型调用带 operation 与 prompt version；
4. Reviewer 在调用模型前执行确定性字数硬门槛；
5. 合法 model JSON 转换为稳定领域结果；
6. 无效 JSON、非法 shape 和缺少章节结果返回 `inconclusive`，而不是 passed；
7. Python compatibility fixture 与 TS target fixture 都有测试证据；
8. Python 既有 API 测试恢复为可运行基线。

## 实施结果

### `packages/model-runtime`

- 定义 `TextModel` request/response port；
- request 包含 operation、prompt version、system/user prompt、max tokens、AbortSignal 和 metadata；
- response 统一 text、provider、model、finish reason、usage 和 request id；
- `ModelRuntimeError` 统一错误码、retryable、provider 和 cause；
- `parseJsonObject` 保留 Python 对 direct/fenced/surrounding JSON 的 tolerance，同时只接受 object。

### `packages/agent-core`

- `PlannerService` 通过 `TextModel` 调用，迁移 outline prompt、解析与 budget trim；
- `ReviewerService` 先执行确定性字数门槛，再调用模型；
- Reviewer 领域结果使用 `passed | failed | inconclusive`；
- prompt 和 agent core 使用显式版本常量；
- Unicode 字数按 code point 计算，与 Python `len()` 对齐；
- `pythonRound` 保持 Python half-to-even 与浮点边界语义；
- 架构测试扫描源码，阻止核心包导入 Next.js、LangGraph、provider SDK、Drizzle/Postgres、BullMQ 或 Langfuse。

### 共享迁移 dataset

`agent-component-baseline-v1` 由 contracts Zod schema 校验，并同时保存：

- Python compatibility verdict；
- TypeScript target verdict；
- intentional safety delta。

Python 新增 fixture 测试读取同一 dataset。原有 Agent 测试 double 补齐真实 Anthropic text block 的 `type="text"`，使测试重新覆盖生产提取分支。详细矩阵见 [Eval 0001](../evals/0001-planner-reviewer-deterministic-baseline.md)。

## 验证证据

```bash
pnpm test:model-runtime
pnpm typecheck:model-runtime
pnpm test:agent-core
pnpm typecheck:agent-core
pnpm test:contracts
pnpm typecheck:contracts
pnpm test:api
pnpm lint:web
pnpm test:web
pnpm build:web
pnpm check:docs
git diff --check
```

实际以 `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify` 运行完整自动化验证；`pnpm verify` 包含可复现的 `pnpm check:docs`，只把工作树空白检查 `git diff --check` 留作单独命令：

| 范围 | 结果 |
|---|---|
| contracts | 2 个文件、12 项测试；typecheck 通过 |
| model-runtime | 1 个文件、8 项测试；typecheck 通过 |
| agent-core | 2 个文件、31 项测试；typecheck 通过 |
| db | 1 个文件、8 项测试；typecheck 与 migration check 通过 |
| API | 45 项 pytest 全部通过 |
| Web | lint、6 个文件/12 项测试、Next.js production build 通过 |
| 工作树/文档 | `git diff --check` 通过；`pnpm check:docs` 检查 22 份 Markdown，相对链接全部有效 |

### 首次失败与修正

1. Python Agent 测试原先只给 `MagicMock.text`，没有真实 content block 的 `type="text"`，导致 11 项测试误走空响应；修正 test double 后完整 API 45 项通过。
2. 初版 `pythonRound` 对 `.5` 使用过宽浮点容差，把 `57.49999999999999` 当成精确半数并从 57 变为 58；改为只对精确 `.5` 执行 half-to-even，并保留回归测试。
3. 初版 TS 字数使用 UTF-16 `.length`，emoji 会比 Python 多计数；改为 Unicode code point 计数并加入混合中文/emoji 样本。
4. 初版 outline 首字符只匹配 ASCII digit；改为 Unicode number，新增全角数字 fixture 与 Python 双端验证。
5. lockfile-only 安装在 sandbox 内因 registry DNS 失败；获得网络许可后只更新 lockfile，没有重装 workspace 依赖树。

## 行为差异

| 情况 | Python compatibility | TypeScript target |
|---|---|---|
| Reviewer 非法 JSON | passed | inconclusive |
| `passed` 是字符串 | truthy → passed | schema invalid → inconclusive |
| full results 缺项 | 缺项补 passed | 缺项 inconclusive |

这是 ADR-0006 批准的安全修正。未来 graph 必须为 inconclusive 定义有限重试、结构化失败或人工处理，不能再映射成通过。

## 回滚

Planner/Reviewer 尚未接入运行时，因此撤回 `packages/model-runtime`、`packages/agent-core`、共享 component fixture、根级脚本和本迭代文档即可恢复到 0004 状态，不涉及数据库或流量回滚。

Python test double 修正只让测试匹配真实 response shape，不改变生产代码；即使撤回 TS 包也建议保留。若必须整体回滚，可同时移除新增 fixture pytest 并恢复测试文件，但 API 测试会重新暴露既有假失败。

## 剩余风险与下一步

- 尚无真实 provider adapter、timeout/retry/usage/trace 验证；
- 尚无真实文章 dataset、固定 model profile 或主观质量 grader；
- Planner/Reviewer prompt 虽从 Python 迁移，但还没有运行 shadow model compare；
- Opinion、Search、Writer/tool loop、export 和 LangGraph.js 尚未迁移；
- `inconclusive` 尚未接入 graph retry/terminal policy；
- 当前 API/Agent 仍是 FastAPI/Python。
- Python 3.14.5 的完整 pytest 虽全绿，但产生 2236 条 asyncio/FastAPI/`utcnow()` deprecation warning；这是旧运行时维护债，不属于 TS 组件等价证据。

下一迭代应迁移 Opinion/Search 的输入输出与 search port，建立不发真实网络请求的 tool/component eval；在 Writer tool loop 迁移前，不急于组装完整图。

## 独立读者测试

无对话背景的读者只读取 ADR-0006、本记录、Eval 0001 和系统设计，能够正确回答：

- 当前运行时是否已切流；
- 为什么使用自有 `TextModel` port；
- 已迁与未迁组件；
- Reviewer compatibility/target intentional delta；
- dataset 与完整验证能证明和不能证明的范围；
- 为什么下一步是 Opinion/Search 而不是立即组图。

首次读者测试发现四处文档问题，已修正：统一 `TextModel` 名称、更新实际组件迁移顺序、区分自动化与工作树检查、补充 eval 的 base revision/dirty state/环境与源码哈希。另补充了原始 prompt/response 默认不持久化的隐私边界。第二次读者测试确认这些问题解决，并推动把临时链接检查固化为 `scripts/check-markdown-links.mjs` / `pnpm check:docs`，纳入 `pnpm verify`。
