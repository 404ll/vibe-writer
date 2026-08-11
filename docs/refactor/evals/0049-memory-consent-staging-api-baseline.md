# Eval 0049：Memory Consent Staging API 工程基线

- 日期：2026-08-09
- 结论：Passed for shared contract, Next.js staging behavior, repository authorization and real PostgreSQL RLS regression; deployed auth/policy UI and production consumer remain unverified
- 对应迭代：[0053](../iterations/0053-versioned-memory-consent-staging-api.md)

## 行为矩阵

| 条件 | 预期结果 |
|---|---|
| durable或Memory feature关闭 | 503，repository不执行 |
| feature开启但policy version缺失/非法 | API 503，durable readiness 503 |
| 缺少`Idempotency-Key` | 428 |
| client policy落后于server policy | 409并返回当前version，signal不创建 |
| viewer创建自己的principal signal | 201，显式consent与retention持久化 |
| viewer创建workspace/project signal | 403 |
| editor创建shared signal | repository允许 |
| 同key同payload重试 | 200并返回同一signal |
| 同key不同payload | 409 |
| list | 只返回当前principal自己的未过期signal，`no-store` |
| 作者或owner删除 | 200 content-free receipt，派生数据按repository语义清除 |
| 非author非owner删除 | 403 |
| signal/source run不可见 | 统一404 |

## 数据边界

- API响应可包含用户自己提交的source text，但不包含workspace/author内部字段、request/evidence fingerprint、idempotency key或outbox状态；
- consent policy version由server配置决定，客户端只证明自己确认了哪个version；
- create事务会写pointer-only extraction outbox，但本轮不注册production Memory consumer；
- delete receipt只含signal id、reason、时间与replay状态，不含已删除正文；
- trusted-proxy membership与PostgreSQL RLS仍是双重workspace边界。

## 验证证据

- contracts 27/27与typecheck通过；
- Web 41/41，覆盖feature/config、policy mismatch、幂等、DTO、list、权限错误和delete receipt；
- Next production build包含collection/item Route Handler；
- Memory source repository 7/7、全DB 120/120与DB typecheck通过；
- 真实PostgreSQL DB 21/21、checkpoint 4/4、live sampler 1/1；
- 根级`pnpm verify`通过，覆盖contracts/model/provider/eval/memory/agent/workflow/DB/checkpoint/Worker/Python API/Web，Memory calibration仍为`no_go`；
- 170-file文档链接检查与`git diff --check`通过；没有读取真实provider credentials或执行付费调用。

## 尚未证明

- 真实reverse proxy会剥离伪造header并注入canonical identity；
- 非owner API role具备最小权限且没有`BYPASSRLS`；
- 用户UI实际展示了与version对应的policy正文；
- production consumer、真实模型质量、费用和retrieval uplift。
