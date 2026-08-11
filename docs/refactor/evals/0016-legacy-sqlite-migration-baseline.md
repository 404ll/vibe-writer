# Eval 0016：Legacy SQLite Migration 基线

- 日期：2026-08-07
- Protocol：`legacy-sqlite-import-v1-target-2026-08-07`
- 状态：Passed

## 评测范围

验证SQLite article/version读取、目标provenance合成、dry-run/apply/replay与collision语义，以及迁移结果被durable Next路径读取。fixture是合成数据，不代表实际部署source已经通过审计。

## 结果

| 场景 | 结果 |
|---|---:|
| SQLite query-only读取与文件SHA-256 | Passed |
| UUID、timestamp、count、orphan/schema验证 | Passed |
| dry-run零写入 | Passed |
| synthetic completed job/run/done | Passed |
| article/job UUID保持 | Passed |
| version排序与source revision映射 | Passed |
| exact apply replay | Passed |
| content/source hash collision | Passed |
| outbox不产生新执行 | Passed |
| 真实PostgreSQL CLI dry-run/apply/replay | Passed |
| durable list与Server Component读取 | Passed |
| DB package regression | 51/51 |
| Full verify | Passed；TS/Python/Web/migration/docs无回归 |

## 已知差异

- PostgreSQL version `id`重新分配；UI通过每次读取版本列表使用新id，article id保持不变。
- 旧restore产生的重复快照不被改写；它们只按旧saved timestamp/id映射revision。
- legacy job/run版本明确标记unknown，不伪装为当前TS执行。
- legacy word count原样保留，可能与新计数器不同。

## 结论与限制

本基线证明迁移协议和工具可以在隔离环境中安全重放，并满足PostgreSQL外键/provenance约束。它不证明实际部署SQLite source为空或完全合法，也不覆盖tenant归属、生产备份恢复、超大数据批次、在线写入或用户验收；实际apply前仍必须保存dry-run报告并执行runbook。
