# Eval 0048：Memory Retention Maintenance 工程基线

- 日期：2026-08-09
- 结论：Passed for DB-time expiry, source-first erasure, bounded backlog draining, replay, and PostgreSQL lock skipping; hosted scheduling and alert delivery remain unverified
- 对应迭代：[0052](../iterations/0052-durable-memory-retention-maintenance.md)

## 行为矩阵

| 条件 | 结果 |
|---|---|
| 无到期数据 | `idle`，删除数与backlog均为0 |
| source signal到期 | 先settle extraction/outbox，再删除source正文并留tombstone |
| active Memory/candidate到期 | 删除revision/candidate正文，active Memory留下slot fingerprint tombstone |
| batch小于due inventory | 返回剩余due样本，runtime使用短轮询继续排空 |
| backlog达到阈值或样本cap | `backlog_alert`结构化报告 |
| batch临时失败 | 记录error，进程保持ready并按常规周期重试 |
| 两个PostgreSQL session | 第二实例跳过第一实例锁定行并处理下一条 |
| shutdown | draining后停止loop，再关闭database/health |

## 数据边界

- report只包含count、阈值、worker id和时间，不含source text、Memory content、prompt或model output；
- source signal与Memory tombstone不保存正文；
- maintenance不导入provider runtime、BullMQ或Redis；
- 所有deadline判断由PostgreSQL `clock_timestamp()`完成；
- cleanup transaction失败会回滚本批，成功批可幂等重放为空操作。

## 未证明

- 未在托管PostgreSQL、连接池代理或Kubernetes多副本中运行；
- 未建立production最小权限maintenance role；
- 未接真实metrics/alert channel，也未测量大规模backlog吞吐；
- 未定义tombstone自身的长期retention；
- 未启用production Memory extraction、retrieval或context injection。

## 验证证据

- DB targeted 31/31；Worker targeted 15/15；
- 真实PostgreSQL DB 21/21、checkpoint 4/4、live sampler 1/1；
- scoped全包回归：DB 120/120、Worker 87/87，相关typecheck与migration check通过；
- 根级`pnpm verify`通过，覆盖contracts/model/provider/eval/memory/agent/workflow/DB/checkpoint/Worker/Python API/Web；Next.js production build与167-file文档链接检查通过；
- `git diff --check`通过；没有读取真实provider credentials或执行付费调用。
