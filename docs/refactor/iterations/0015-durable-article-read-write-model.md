# Iteration 0015：Durable Article Read/Write Model

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R5 Worker/API cutover
- 对应决策：[ADR-0016](../decisions/0016-article-revision-and-version-cutover.md)

## 目标

让 terminal transaction 生成的 PostgreSQL article 可以通过独立、默认关闭的 Next.js staging API 完成 list/detail/edit/version/restore，并用 revision + immutable snapshot 防止并发覆盖和恢复丢稿；不提前切换现有产品流量。

## 范围内

- 迁移期共享 article contract 的 revision/source revision/mutation response；
- PostgreSQL ArticleRepository 的读模型、原子 PATCH 和 restore；
- 变更前快照、content fingerprint、word count 和 revision bump；
- PGlite 与真实 PostgreSQL 多 session 并发写测试；
- `/api/durable/articles*` Route Handler、错误边界和 route tests；
- ADR、Eval、系统设计、路线图和验证记录。

## 范围外

- 不切换当前 Server Component 的 FastAPI article source；
- 不切换浏览器 `API_BASE`，不删除 Python article router；
- 不迁移 SQLite 历史文章/版本；
- 不实现认证、tenant/RLS、协同编辑或 diff/merge UI；
- 不覆盖本地 `output/*.md`；
- 不接真实 provider 或生产 Worker/dispatcher。

## 必须证明的行为

1. terminal article 可 list/detail，wire shape 与现有 UI 字段兼容；
2. PATCH 在同事务保存旧 current revision 并更新 current；
3. restore 保存恢复前 current，而不是复制恢复目标；
4. 两个 session 用同 expected revision 时只有一个成功；
5. stale/missing version 不更新正文且不新增快照；
6. durable response 暴露权威 revision，409 暴露 current revision；
7. disabled flag 仍 503，现有 FastAPI route 不受影响；
8. DB/Web/build/full verify、真实 PostgreSQL、docs/diff check 通过。

## 实现结果

- 共享 article contract 在保持 Python fixture 可解析的同时增加 optional `revision` / `source_revision`、restore request 和 mutation response。durable PATCH/restore 强制提交 `expected_revision`。
- 新增 PostgreSQL `ArticleRepository`：list/detail/version read model，以及 row lock、revision recheck、pre-mutation snapshot、fingerprint/word count/revision bump 的 PATCH/restore transaction。
- restore 现在保存恢复前 current draft，修正 Python 路径“保存恢复目标副本、无法撤销恢复”的语义缺口；该行为作为明确 intentional delta 写入 ADR。
- PGlite 覆盖 terminal projection、PATCH、restore、missing version 和同 revision 并发；真实 PostgreSQL 两个独立 session 证明一个 writer updated、另一个 revision conflict，只有一个 snapshot。
- Next.js 新增 5 条默认关闭的 `/api/durable/articles*` dynamic routes：list、detail/PATCH、versions、version detail、restore。响应沿用现有 article 字段名并增加权威 revision；stale write 返回 `409 + current_revision`，缺少 PATCH precondition 返回 428。
- route 使用与 jobs 相同的 lazy PostgreSQL pool 和 `DURABLE_API_ENABLED` 门禁。当前 Server Component/FastAPI rewrite/API_BASE 均未修改。

## 验证证据

- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：contracts 20、model runtime 9、agent core 92、workflow 47、DB 47、checkpoint 8、worker 36、Python API 50、Web 22；migration/typecheck/lint/build/docs 全通过。
- `pnpm test:db:postgres:local`：真实 PostgreSQL DB 9/9、PostgresSaver 4/4；新增 multi-session article revision single-winner 用例通过，临时实例已停止。
- Next production build 输出 5 个 `/api/durable/articles*` dynamic routes；`next start -H 127.0.0.1 -p 4320` smoke：`GET /` 200、disabled `GET /api/durable/articles` 503，服务已停止。
- `git diff --check` 与 Markdown link check 通过。

## 遗留边界

- 当前文章页面仍从 FastAPI/SQLite 读取，durable route 只是 staging surface。
- mutation client 仍需在正式切流时带 expected revision 并处理 409 refresh/merge UX；当前 legacy client 不能直接指向 durable route。
- 没有 tenant ownership 时不能对公网启用 durable article route。
- PostgreSQL 与 SQLite 没有双写或 backfill；数据切换策略仍需单独 migration/runbook。
