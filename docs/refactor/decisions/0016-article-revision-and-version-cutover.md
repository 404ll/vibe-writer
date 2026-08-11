# ADR-0016：Article Revision、版本快照与切流边界

- 状态：Accepted
- 日期：2026-08-07

## 背景

当前 Python/SQLite 文章接口提供 list/detail/edit/version/restore，但写操作没有并发条件：两个浏览器可以后写覆盖先写。PATCH 会先保存旧内容，这一点正确；restore 则先覆盖当前稿、再把恢复目标写成新快照，无法保留恢复前的当前稿。TypeScript terminal transaction 已经把生成结果写入 PostgreSQL `articles`，但没有可供页面读取和编辑的 repository/Route Handler，因此 durable job 返回的 `article_id` 仍不能被当前文章页完整消费。

文章表同时保存生成 provenance（source run、graph/prompt/code version）和可编辑正文。用户编辑正文不应改写生成 provenance，也不能把本地导出文件当作当前文章真相。

## 决定

1. PostgreSQL `articles.revision` 是文章当前稿的单调乐观并发版本，从 terminal export 的 `0` 开始；每次成功 PATCH 或 restore 加一。
2. durable PATCH 和 restore 必须提交 `expected_revision`。事务先 `SELECT ... FOR UPDATE`，再校验 revision；不匹配返回 `409` 和 `current_revision`，不创建快照、不覆盖正文。
3. 每次成功 mutation 都先把**变更前的当前稿**写入 `article_versions`，其 `(article_id, source_revision)` 唯一；随后更新正文、fingerprint、word count、revision 和 updated_at。restore 也遵循同一顺序，而不是保存恢复目标的副本。
4. `article_versions` 是不可变快照。版本详情只读取指定 article 下的 version id，不能跨文章读取或恢复。
5. list/detail/version 的 wire shape 保留当前 Python 字段名；durable 响应增加 `revision` / `source_revision`。共享 contract 在迁移期把这些响应字段设为 optional，使现有 Python fixture 继续成立；durable mutation 仍强制 revision precondition。
6. PATCH/restore 成功返回 `status: ok` 和新的 article detail，使客户端能采用数据库权威 revision，而不是自行猜测。Python 的 `{status: ok}` 仍可被迁移期 response contract 接受。
7. 文章正文必须非空且不超过 8 MiB。word count 使用移除 Unicode whitespace 后的 code point 数，与 TS terminal projection 保持一致。
8. Next.js 文章 Route Handler 位于 `/api/durable/articles*`，与 jobs routes 共用 `DURABLE_API_ENABLED=true` fail-closed 门禁和 PostgreSQL pool；本迭代不修改当前 `/api/* → FastAPI`、Server Component 的 Python source 或浏览器 `API_BASE`。
9. 用户编辑只更新 PostgreSQL 当前稿与快照，不覆盖 terminal export 时生成的本地 Markdown 文件，也不修改 source run/provenance。未来导出当前稿应是显式命令。
10. 正式切流前必须补齐认证/tenant ownership、SQLite 历史迁移、当前 Web revision-aware client、真实 provider/Worker deployment 和 shadow/e2e 门禁。

## 不变量

- 同一个 `expected_revision` 最多一个 writer 成功；失败 writer 不产生版本记录。
- 每个已离开的 current revision 恰好有一个不可变快照。
- restore 后可以从新快照找回恢复前的当前稿。
- article mutation 不改写 job/run terminal history 或生成 provenance。
- durable article API 未显式启用时不建立数据库请求，也不改变现有产品路径。

## 未选择

- last-write-wins：会静默丢失用户编辑。
- 用时间戳作为并发条件：精度、序列化和时钟语义不如整数 revision 清楚。
- restore 后保存恢复目标：不能撤销恢复动作。
- 直接把 PostgreSQL article id 交给仍读取 SQLite 的页面：会产生完成后 404。
- 每次编辑同步覆盖 `output/*.md`：本地文件不适合多实例业务真相，也会把数据库事务与文件系统副作用耦合。
