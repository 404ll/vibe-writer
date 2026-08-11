# Eval 0015：Readiness 与切流控制基线

- 日期：2026-08-07
- Protocol：`readiness-cutover-v1-target-2026-08-07`
- 状态：Passed

## 评测范围

验证API/Worker健康语义、article读源开关和一次性基础设施中的durable Web+Worker联合路径。它是部署控制面与数据源一致性基线，不是公开生产就绪或live模型质量结论。

## 结果

| 层级 | 结果 | 证明范围 |
|---|---:|---|
| Worker unit/integration | 49/49 | health配置、依赖启动顺序、draining/close、既有runner回归 |
| Web | 27/27 | live/ready fail-closed、article source default/durable分支、既有UI/API回归 |
| Next build | Passed | durable live/ready与全部job/article routes可构建 |
| Production composition | 1/1 | 真实PG+Redis、Worker `/live`/`/ready`、job到article/done |
| Durable Web smoke | Passed | `/api/durable/health/ready`、article list、Server Component PostgreSQL读取 |
| Content source invariant | Passed | durable client build与article read flag共同启用，页面命中同一PG数据 |
| Full verify | Passed | TS/Python/Web/migration/docs无回归 |

## 故障语义

- durable API disabled：liveness 200，readiness 503且不连接数据库；
- 数据库不可达或schema缺失：readiness 503，不返回内部错误；
- Worker starting/draining：readiness 503；依赖全部完成后才200；
- 未设置article flag：Server Component保持Python基线；显式设置后不调用FastAPI。

## 结论与限制

本基线证明切流配置不再只控制浏览器API，而能同时控制Server Component文章读源，并且API/Worker有独立readiness。它不覆盖认证/tenant、SQLite backfill、真实provider、生产代理、OS故障、数据对账或用户流量，因此runbook仍将公开切流标为No-Go。
