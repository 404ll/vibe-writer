# Legacy SQLite Article → PostgreSQL 迁移 Runbook

> 当前worktree中的 `apps/api/data/vibe_writer.db` 在2026-08-07审计时为0篇article、0条version；这不证明实际部署数据库为空。执行时必须使用部署环境的只读副本并重新生成source hash。

## 1. 前置条件

- 停止会写SQLite的Python API/Agent，确认没有进行中的export/edit/restore；
- checkpoint并清理SQLite WAL，工具会拒绝非空 `*-wal`；
- 备份source SQLite与target PostgreSQL，并记录恢复步骤；
- target已运行当前Drizzle migration；
- legacy article/job id均为UUID；非法数据先人工形成映射决策，不要改工具绕过；
- 在受限环境执行，连接串只通过环境变量提供。

## 2. Dry-run

```bash
LEGACY_MIGRATION_DATABASE_URL='postgresql://...' \
  pnpm migrate:articles:sqlite -- \
  --source /absolute/path/to/vibe_writer.db
```

保存JSON报告中的 `sourceSha256`、article/version数量、`wouldImport`和`replayed`。dry-run会读取target做collision检查，但不写job/run/article/version/event。

## 3. Apply

只有报告和备份经复核后才执行：

```bash
ALLOW_LEGACY_SQLITE_IMPORT=true \
LEGACY_MIGRATION_DATABASE_URL='postgresql://...' \
  pnpm migrate:articles:sqlite -- \
  --source /absolute/path/to/vibe_writer.db \
  --apply \
  --expected-source-sha256 'sha256:<dry-run-value>'
```

source文件变化、WAL出现或hash不匹配时apply会在写入前失败。

## 4. Replay 与核对

以同一命令再次apply，期望 `imported=0`、`replayed=<article count>`。随后核对：

```sql
select count(*) from jobs where idempotency_key like 'legacy-sqlite:job:%';
select count(*) from articles where export_idempotency_key like 'legacy-sqlite:article:%';
select count(*) from article_versions av
join articles a on a.id = av.article_id
where a.export_idempotency_key like 'legacy-sqlite:article:%';
select a.id, a.revision, count(av.id) as snapshots
from articles a left join article_versions av on av.article_id = a.id
where a.export_idempotency_key like 'legacy-sqlite:article:%'
group by a.id, a.revision
having a.revision <> count(av.id);
```

最后一条必须返回0行。还需抽样比对topic、current content、历史版本顺序、source word count、created/saved timestamp，并通过durable article页面渲染。

## 5. 回滚

不要在未验证外键影响时手写批量DELETE。迁移前应使用独立target snapshot；失败或核对不通过时恢复PostgreSQL备份，再修正source/协议后重新dry-run。source SQLite保持只读备份直到Python退役窗口结束。

## 6. 已验证边界

`pnpm test:worker:production:local`会构造一次性SQLite fixture，在真实PostgreSQL上执行dry-run → apply → replay，再通过durable Next article list和Server Component读取迁移文章。它不证明实际部署SQLite数据质量，实际source仍必须按本runbook独立审计。
