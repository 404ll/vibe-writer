# Iteration 0052：Durable Memory Retention Maintenance

- 日期：2026-08-09
- 状态：Done
- 对应决策：[ADR-0053](../decisions/0053-durable-memory-retention-maintenance.md)
- 评测记录：[Eval 0048](../evals/0048-memory-retention-maintenance-baseline.md)
- 运维说明：[Memory retention runbook](../runbooks/memory-retention-maintenance.md)

## 目标

把现有Memory/source-signal `expireDue()`从被动repository方法升级为独立、可并发扩缩、可探测并能持续排空backlog的TypeScript maintenance runtime。

## 范围内

- source signal、active Memory和candidate的有序maintenance service；
- DB-time、有界batch、`SKIP LOCKED`与稳定deadline/id顺序；
- 全局到期扫描专用索引migration；
- bounded backlog inspection与versioned content-free batch report；
- backlog短轮询、正常长轮询、错误重试和优雅shutdown；
- 独立health/schema readiness、配置、入口和运行脚本；
- PGlite内容删除/墓碑/重放，以及真实PostgreSQL双会话锁跳过证据；
- ADR、Eval、runbook、系统设计和路线图同步。

## 范围外

- 不启用真实provider或production Memory extraction；
- 不依赖Redis、模型凭据或外部scheduler；
- 不接Prometheus、OTel或托管告警平台；
- 不创建部署环境的数据库role或credentials；
- 不实现Memory管理UI、retrieval或workflow context injection；
- 不把health readiness当作backlog SLA。

## 验证

- targeted DB：Memory、source signal与architecture共31项通过；
- targeted Worker：service/runtime/PGlite/architecture共15项通过；
- `pnpm test:db:postgres:local`：DB 21、checkpoint 4、live sampler 1及Eval replay通过；
- scoped package gate：DB 120/120、Worker 87/87，DB/Worker typecheck与Drizzle migration check通过；
- 根级`API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`通过：contracts 25、model runtime 9、provider runtime 11、eval core 10、eval graders 5、memory core 26、Eval CLI 47、agent core 93、workflow runtime 48、DB 120、checkpoint runtime 8、Worker 87、Python API 50、Web 31；component、Memory governance、Memory extraction与workflow shadow Eval通过，Memory calibration按预期保持`no_go`，Next.js production build通过；
- `pnpm check:docs`检查167个Markdown文件通过，`git diff --check`通过。

## 退出条件

1. 到期source先settle extraction erasure，再清理generic Memory数据：满足。
2. 多实例通过真实PostgreSQL `SKIP LOCKED`不争抢同一source：满足。
3. 到期查询有匹配的global ordered index且全部使用DB clock：满足。
4. 有界batch可暴露剩余due work并在短周期继续排空：满足。
5. idle/progress/backlog/error不携带Memory正文：满足。
6. schema未迁移时readiness失败，shutdown停止loop后再关DB/health：满足。
7. 进程默认关闭且不要求Redis/provider credentials：满足。

## 后续

1. 为maintenance部署专用最小权限PostgreSQL role并验证RLS/权限矩阵；
2. 把`backlog_alert`投影到metrics/alerting adapter并定义SLO；
3. 为tombstone retention本身制定合规保留与聚合策略；
4. 推进staging user-authored signal API和管理UI，使产品可显式创建/查看/删除Memory；
5. 在真实calibration完成后再启用shadow production consumer与retrieval Eval。
