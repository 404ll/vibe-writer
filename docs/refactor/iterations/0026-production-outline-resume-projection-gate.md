# Iteration 0026：Production Outline Resume Projection Gate

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0027](../decisions/0027-production-outline-resume-projection-gate.md)
- 评测记录：[Eval 0022](../evals/0022-production-outline-resume-baseline.md)

## 目标

把人工大纲确认从单项 reply/checkpoint 测试提升为版本化 production projection，证明真实 Worker pause、持久化 command、resume outbox、第二次 claim 和最终文章可闭环。

## 范围内

- production composition dataset/target/suite v2；
- 复用 `edited-outline-confirm` 跨语言 expected；
- 真实 `awaiting_input → submitOutlineReply → queued → completed`；
- 两个 run、两个 outbox、interrupt/done event和跨run trace断言；
- durable article API 与 Server Component SSR 检查编辑后大纲；
- tracked v2 baseline、ADR、Iteration与Eval记录。

## 范围外

- 不实现 cancel、failure或takeover production case；
- 不调用HTTP reply route或浏览器SSE；
- 不访问真实provider、托管Redis/PostgreSQL或反向代理；
- 不替换v1历史baseline。

## 验证

- `pnpm test:contracts`：2个文件、22项通过；两个production case都与workflow expected连接；
- `pnpm typecheck:contracts`、`pnpm typecheck:worker`：通过；
- `pnpm test:worker:production:local`：production Eval 2/2通过；真实PostgreSQL、Redis/BullMQ、Worker、PostgresSaver、legacy SQLite migration、带身份header的durable API/SSR通过；临时服务已停止；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 345项、Python 50项，共395项通过；Web lint/build、全部typecheck、migration check、38-case component gate与3-case workflow shadow gate通过；
- `pnpm check:docs`：87个Markdown文件链接通过；
- `git diff --check`：通过。

## 退出条件

1. pause run持久化`outline_ready`并释放lease：满足。
2. reply产生resume outbox和第二个run：满足。
3. edited outline进入最终article且命中workflow expected：满足。
4. v2 tracked baseline为两条case并全部通过：满足。
5. Next durable read path渲染恢复文章：满足。

## 后续

1. cancellation production projection；
2. provider/graph terminal failure projection；
3. expired lease takeover与uncertain effect projection；
4. 将reply/cancel跨workspace HTTP负例加入联合harness。
