# ADR-0021：Legacy SQLite Article 导入协议

- 状态：Accepted
- 日期：2026-08-07

## 背景

Python/SQLite只持久化 `articles` 与 `article_versions`，job执行态在内存中；PostgreSQL目标模型则要求article关联持久化job、source run和版本快照。直接复制两张表会违反外键和provenance约束。旧restore还会把恢复目标再次追加为version，而新语义保存恢复前current draft；迁移不能在没有证据时“修复”历史。

## 决定

1. 迁移只接受有效UUID的legacy `article.id`和`job_id`并原样保留，避免历史article URL失效。非法identity直接失败，不静默生成新bookmark。
2. 每篇legacy article生成一个deterministic UUID source run，并创建标记为completed/export的synthetic job、completed run和单个done event；不创建outbox，避免迁移数据被Worker再次执行。
3. synthetic provenance显式写为 `legacy-python` / `unknown`，`code_revision`包含迁移协议版本与完整source SQLite SHA-256。不得把未知模型、prompt、graph或tool版本伪装成当前版本。
4. legacy versions按 `saved_at ASC, legacy id ASC`稳定排序并赋予 `source_revision=0..n-1`；current article `revision=n`。内容、source word count和时间戳原样保留，version数据库id允许由PostgreSQL重新分配。
5. source reader以read-only/query-only打开SQLite；发现非空WAL、缺表、orphan version或读取期间文件hash变化时失败。`node:sqlite`只从ops专用subpath加载，不进入Web/Worker主runtime import graph。
6. CLI默认dry-run。apply必须同时提供 `ALLOW_LEGACY_SQLITE_IMPORT=true`、`--apply`和dry-run确认的 `--expected-source-sha256`；目标使用独立 `LEGACY_MIGRATION_DATABASE_URL`，避免误用Python `DATABASE_URL`。
7. apply在PostgreSQL事务中运行。相同source与目标数据重复执行返回replayed；article/job/run/content/version/provenance任一不一致都报collision，不覆盖已有数据。
8. migration不自动运行Drizzle migration、不删除source SQLite、也不提供在线双写。操作者必须先停止Python writer、备份source和target，再按runbook执行。

## 不变量

- dry-run不得写任何target row。
- 一篇legacy article只能对应一个deterministic synthetic job/run和一个done event。
- 重放只能接受逐字段一致的数据；source hash变化不能复用旧provenance。
- legacy版本历史按事实保存，不用新restore语义反推或改写旧内容。
- runtime主入口不加载SQLite reader。

## 未选择

- 让 `articles.source_run_id` 可空：会永久削弱新数据provenance约束。
- 为非法legacy id自动随机UUID：会破坏URL并让replay无法稳定识别。
- 把legacy versions转换成“理想的新语义”：无法区分PATCH与restore产生的重复快照。
- 在线读取SQLite作为长期fallback：继续保留双数据真相并阻塞Python退役。
