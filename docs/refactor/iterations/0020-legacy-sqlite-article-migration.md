# Iteration 0020：Legacy SQLite Article Migration

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R5 Worker/API cutover / R8 Python retirement prerequisite
- 对应决策：[ADR-0021](../decisions/0021-legacy-sqlite-article-import.md)
- 运维入口：[Legacy SQLite迁移Runbook](../runbooks/legacy-sqlite-article-migration.md)

## 目标

提供一条默认只读、可审批、幂等且可核对的SQLite article/version导入路径，补齐PostgreSQL强制job/run provenance，并保持历史article UUID和快照事实。

## 范围内

- read-only/query-only SQLite reader与source SHA-256；
- WAL/source mutation/orphan/schema检查；
- manifest与UUID/content/time/count验证；
- deterministic synthetic job/run/done provenance；
- version排序、source revision与current revision映射；
- transactional dry-run/apply/replay/collision协议；
- 显式双重apply授权CLI；
- PGlite集成与真实PostgreSQL+Next联合验证；
- ADR、Runbook、Eval和文档索引。

## 范围外

- 不对实际部署数据库执行迁移；当前worktree SQLite为空且不能代表生产；
- 不支持非UUID identity自动映射；
- 不修改旧版本内容或推断PATCH/restore意图；
- 不实现在线双写、增量CDC或长期SQLite fallback；
- 不解决auth/tenant namespace；
- 不删除Python/SQLite文件。

## 实现结果

- `@vibe-writer/db`新增legacy import协议；reader隔离在 `@vibe-writer/db/legacy-sqlite`，生产runtime主入口不加载实验性Node SQLite模块。
- import为每篇文章保留article/job UUID，派生稳定run UUID，写入显式unknown legacy版本和source hash，不创建outbox。
- 旧versions按timestamp/id排序并原样保存；article revision等于snapshot数量，未来新编辑可从下一revision继续。
- CLI默认dry-run；apply需要enable env、apply flag和approved source hash，错误只输出结构化message且不打印数据库URL或正文。
- 相同输入重复apply为replay；current content或source provenance改变会collision并回滚事务。
- 联合harness在真实PostgreSQL导入fixture后，durable article list包含新/旧两篇文章，Server Component以保留的legacy UUID成功渲染。

## 验证证据

- `pnpm test:db`：51/51；含4项legacy reader/import/replay/collision集成。
- `pnpm typecheck:db`、`pnpm typecheck:worker`：通过。
- `pnpm test:worker:production:local`：真实PostgreSQL dry-run/apply/replay与Next读取通过，临时PG/Redis/Next均停止。
- `pnpm build:web`：通过且不再从runtime主入口加载 `node:sqlite`。
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：contracts 20、model 9、provider 5、agent 93、workflow 48、DB 51、checkpoint 8、Worker 49、Python API 50、Web 27；migration、lint、build和69份文档链接全通过。
- `git diff --check`：通过。完整结论见 [Eval 0016](../evals/0016-legacy-sqlite-migration-baseline.md)。

## 遗留边界

- 实际部署source可能包含非法UUID、WAL、孤儿version或并发写，需要先独立dry-run；fixture通过不能替代数据审计。
- source word count按旧语义保留，可能与当前Unicode whitespace计数不同；这是兼容事实，不应在迁移时静默重算。
- auth/tenant schema落地后，导入协议还必须增加namespace归属；在此之前公开切流仍为No-Go。
