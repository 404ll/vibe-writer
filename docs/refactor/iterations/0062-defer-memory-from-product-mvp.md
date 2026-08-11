# Iteration 0062：Memory 从产品 MVP 延后

- 日期：2026-08-11
- 状态：Done
- 对应决策：[ADR-0063](../decisions/0063-memory-deferred-from-product-mvp.md)

## 目标

让“当前不做Memory”成为真实工程边界，而不只是页面上没有入口：写作主链路不产生Memory任务，durable readiness不依赖Memory schema，产品文档和MVP验收也不再承诺Memory。

## 范围内

- post-run Memory extraction改为显式opt-in，production写作Worker保持关闭；
- Durable API readiness按feature flag组合核心表与Memory表检查；
- `dev:durable`继续强制关闭Memory API，直接访问`/memory`返回404；
- 当前架构、路线图、Web说明与MVP定义移除Memory产品承诺；
- 保留归档实现与回归测试。

## 范围外

- 删除Memory migrations、packages、routes、UI和历史测试；
- 设计新的Memory产品需求、RAG或跨任务context注入；
- 改变既有历史ADR/iteration的事实记录。

## 验收条件

1. 普通Worker完成写作时不产生`memory.extraction.requested`；
2. 显式opt-in仍能生成幂等Memory Outbox事件，避免破坏归档能力；
3. Memory flags关闭时API readiness不要求Memory schema；开启时仍fail closed；
4. Web、Worker、DB定向测试与文档检查通过；
5. 当前MVP文档只描述写作主链路。

## 当前验证

- `pnpm test:db && pnpm typecheck:db`：DB `138/138`通过；覆盖默认不创建Memory Outbox、显式opt-in仍保持幂等，以及收紧后的write consumer role contract。
- `pnpm test:worker && pnpm typecheck:worker`：Worker `91/91`通过；runner明确向terminal传递`requestMemoryExtraction: false`。
- `pnpm test:web && pnpm lint:web && pnpm build:web`：Web `66/66`、lint和production build通过；核心readiness按Memory flag组合检查，运行中的`/memory`在feature关闭时返回404。
- `pnpm test:worker:production:local`：真实PostgreSQL/Redis最小权限composition `5/5`通过；consumer没有Outbox INSERT仍能完成completed、outline resume、cancel、provider failure和lease takeover。
- `pnpm test:durable-product:local`：完整create → outline reply → done → article edit/history/restore通过，revision为`0 → 1 → 2`。
- `API_PYTHON=/absolute/path/to/python pnpm verify`：全仓通过；DB `138/138`、Worker `91/91`、Web `66/66`、FastAPI `50/50`、workflow shadow `3/3`、build/lint/docs均通过。归档Memory测试继续回归，但不代表产品启用。
- `pnpm check:docs`：195个Markdown文件链接通过；`git diff --check`通过。

五项验收条件全部满足。当前产品心智模型在Article持久化与版本恢复结束，不再包含Memory产品面或后台副作用。
