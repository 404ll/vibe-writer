# Eval 0013：Fenced Provider Effects 基线

- 日期：2026-08-07
- Protocol：`fenced-provider-effects-v1-target-2026-08-07`
- 状态：Passed

## 评测范围

验证 graph effect identity、Worker provider wrapper、真实 repository 持久化与敏感内容最小化。无真实 provider key，因此只评价控制面、归因字段和 failure semantics，不评价文章质量、供应商可用性或 exactly-once。

## 覆盖矩阵

| 场景 | 预期 |
|---|---|
| text/tool/search 首次调用 | reserve 成功后才调用 provider，完成后写 succeeded |
| uncertain/non-first reservation | provider 不被调用，显式 fail closed |
| tool loop 多轮 | node scope + request ordinal 生成唯一稳定 key |
| search tool | tool/round/call 进入稳定 effect identity |
| provider failure | bounded error 完成为 failed，不保存原始 payload |
| metadata | 保存版本、用量、延迟、request id 等 allowlist |
| content privacy | prompt、响应正文、query、URL、snippet 不进入 result metadata |
| terminal settlement | succeeded effect 保持 succeeded，只有未完成 reservation 变 uncertain |

## 结果

| 层级 | 结果 | 证明范围 |
|---|---:|---|
| Worker | 47/47 | journal wrapper、factory composition、PGlite 真实 repository 与 terminal 语义 |
| Agent core | 93/93 | effect scope 进入全部 model/search 边界，无组件回归 |
| Workflow | 48/48 | 确定性 node/chapter/attempt scope，无 graph 回归 |
| Full verify | Passed | contracts/model/provider/agent/workflow/DB/checkpoint/worker/API/Web/docs 全链路 |
| Real PostgreSQL | Passed | DB 9/9、PostgresSaver 4/4 回归 |
| Real Redis/BullMQ | Passed | delivery、resume、cancel、stalled、shutdown 8/8 回归 |

## 结论与限制

本基线证明 production composition 中的模型/搜索调用已进入 lease-fenced 业务 journal，并且默认持久化面不包含 prompt、响应正文或搜索内容。它不证明 provider 调用 exactly-once：外部成功而本地 finish 失败仍会形成 uncertain；已成功记录也缺少重建正文所需结果。provider resolver、完整 trace、联合 PostgreSQL+Redis process E2E、live 质量评测和产品切流仍未完成。
