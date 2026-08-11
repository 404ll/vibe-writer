# Eval 0012：Provider/Worker Process 基线

- 日期：2026-08-07
- Protocol：`provider-worker-process-v1-target-2026-08-07`
- 状态：Passed

## 评测范围

验证 provider wire mapping、service composition、取消/style上下文和 Worker进程 lifecycle。无真实 key 时只证明协议/控制面，不声明真实模型质量、供应商可用性或生产部署完成。

## 计划覆盖

- Anthropic text/tool blocks、stop reason、usage、request id 和错误分类；
- Tavily date bounds、document schema 和错误分类；
- outline revise prompt version；
- signal/style贯穿 graph → service → provider；
- dispatcher-only 无 model secret、consumer fail-closed config；
- startup/shutdown order、真实 Redis delivery 与真实 PostgreSQL checkpoint/DB回归；
- full verify、docs和diff check。

## 结果

| 层级 | 结果 | 证明范围 |
|---|---:|---|
| Provider runtime | 5/5 | Anthropic text/tool/usage/error；Tavily date/document/error mapping |
| Agent core | 93/93 | 单独 versioned outline revision prompt，无既有组件回归 |
| Workflow | 48/48 | signal贯穿全部 service，style进入 Writer/provider request |
| Worker | 40/40 | WorkflowServices composition、role config、fail-closed、start/close order |
| Real PostgreSQL | 9/9 + 4/4 | DB fencing/article revision 与 PostgresSaver回归 |
| Real Redis/BullMQ | 8/8 | delivery、resume、cancel、stalled、shutdown回归 |
| Full verify | Passed | TS/Python/Web/migration/docs全链路 |

CLI disabled smoke以结构化 fatal和退出码 1证明默认关闭。没有使用真实 key，因此本结果只把 provider协议映射与进程控制标为 Passed，不把 live provider可用性或文章质量列为已验证。

## 结论与限制

本基线证明 TS runtime已有可配置的真实 provider adapter和可拆分 Worker进程装配，且取消/style执行上下文不再在 graph边界丢失。它不证明托管环境、真实账号/model、provider不确定结果恢复、trace、健康检查或产品切流。
