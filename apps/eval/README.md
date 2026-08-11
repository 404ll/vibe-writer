# @vibe-writer/eval-cli

版本化离线评测入口。组件 suite 把 Planner、Reviewer、Coverage、Search policy/ranking 和 Writer tool loop 的 38 个合成 fixture 统一交给 `@vibe-writer/eval-core`；workflow shadow suite 则让当前 Python 与 TypeScript LangGraph 分别执行同一组脚本化场景，再同时比较显式 expected 与两边的规范化投影。

```bash
pnpm eval:components          # 只读 gate；不会更新 baseline
pnpm eval:components:report   # 输出默认不含正文的 run report
pnpm eval:components:baseline # 只打印候选 baseline，必须审查后手工更新

API_PYTHON=/path/to/python pnpm eval:workflow-shadow
API_PYTHON=/path/to/python pnpm eval:workflow-shadow:report
API_PYTHON=/path/to/python pnpm eval:workflow-shadow:baseline
```

Workflow shadow 会清空子进程的应用凭据，只传递 Python 路径所需的最小环境；provider、搜索和 export 使用 synthetic adapter，不访问网络、数据库或 `output/`。当前 3 个场景覆盖无人工介入完成、编辑大纲后确认和全文审稿失败后重写。Python 的进程内等待与 TypeScript 的 LangGraph interrupt/resume 只比较产品级结果，不证明两者 checkpoint 机制相同，也不是 Worker/Redis/PostgreSQL E2E。

重型 durable projection 复用 workflow happy-path expected，并穿过临时 PostgreSQL、Redis/BullMQ、production Worker、terminal article/effect/trace 和 Next SSR：

```bash
pnpm eval:production-composition:local
```

该命令需要本机 PostgreSQL 工具和 Docker，因此不进入普通 `pnpm verify`。tracked baseline 位于 `apps/eval/baselines/production-composition-v1.json`。

注册到已迁移的 PostgreSQL 需要显式提供 scope 和数据库：

```bash
EVAL_NAMESPACE_KEY=system \
EVAL_DATABASE_URL=postgresql://... \
pnpm eval:components:register
```

命令不会运行 migration，也不会打印数据库 URL。生产用户内容不能使用当前 synthetic suite 注册流程。

把 component suite 登记为 durable queued run 时，必须另外提供调用方生成的幂等键；该命令只写 PostgreSQL request/outbox，不会同步执行 38 个 case，也不要求 Redis 在线：

```bash
EVAL_NAMESPACE_KEY=system \
EVAL_DATABASE_URL=postgresql://... \
EVAL_IDEMPOTENCY_KEY=component-regression-2026-08-07 \
pnpm eval:components:enqueue
```

独立 Eval dispatcher/consumer 默认关闭。已迁移数据库和 Redis 可用后，通过独立进程启动：

```bash
EVAL_QUEUE_ENABLED=true \
EVAL_QUEUE_ROLE=all \
DATABASE_EVAL_DISPATCHER_URL=postgresql://eval_dispatcher@... \
EVAL_DISPATCHER_DATABASE_ROLE=eval_dispatcher \
DATABASE_EVAL_CONSUMER_URL=postgresql://eval_consumer@... \
EVAL_CONSUMER_DATABASE_ROLE=eval_consumer \
EVAL_REDIS_URL=redis://... \
EVAL_WORKER_ID=eval-worker-1 \
pnpm start:eval-worker
```

`EVAL_QUEUE_ROLE` 可取 `dispatcher | consumer | all`，默认队列为 `vibe-writer-eval`；配置会拒绝使用 `vibe-writer-write`。`all`仍要求两个不同URL与role，不回退`EVAL_DATABASE_URL`。Redis job 只含版本和 Eval run UUID，case/expected/report 由 PostgreSQL 持有。registry只接受显式注册的component、live article grader或Memory calibration target，不执行任意target。

live sampler使用第三套独立身份：

```bash
DATABASE_EVAL_LIVE_SAMPLER_URL=postgresql://eval_live_sampler@... \
EVAL_LIVE_SAMPLER_DATABASE_ROLE=eval_live_sampler \
pnpm start:eval-live-sampler
```

部署前由admin分别执行`eval-dispatcher-role:provision`、`eval-consumer-role:provision`和`eval-live-sampler-role:provision`，再从各自runtime连接执行对应`verify`命令。完整顺序见[Eval Runtime角色Runbook](../../docs/refactor/runbooks/eval-runtime-roles.md)。

Memory calibration先quote/preflight，再由workspace owner分别注册、审批和入队。三个命令都只访问PostgreSQL，不调用provider：

```bash
EVAL_DATABASE_URL=postgresql://... \
EVAL_WORKSPACE_ID=... \
EVAL_PRINCIPAL_ID=... \
EVAL_IDEMPOTENCY_KEY=memory-calibration-2026-08-09 \
pnpm eval:memory-calibration:authorize -- register /absolute/path/to/unapproved-manifest.json

EVAL_MEMORY_CALIBRATION_AUTHORIZATION_ID=... \
EVAL_MEMORY_CALIBRATION_BINDING_FINGERPRINT=sha256:... \
EVAL_MEMORY_CALIBRATION_APPROVAL_REASON=operator-reviewed-cost-v1 \
pnpm eval:memory-calibration:authorize -- approve

EVAL_MEMORY_CALIBRATION_AUTHORIZATION_ID=... \
EVAL_MEMORY_CALIBRATION_BINDING_FINGERPRINT=sha256:... \
pnpm eval:memory-calibration:authorize -- enqueue
```

上述approve/enqueue同样需要`EVAL_DATABASE_URL`、`EVAL_WORKSPACE_ID`和`EVAL_PRINCIPAL_ID`。真实executor默认关闭；只有consumer显式设置`EVAL_MEMORY_CALIBRATION_ENABLED=true`及独立的`EVAL_MEMORY_CALIBRATION_ANTHROPIC_API_KEY`、`EVAL_MEMORY_CALIBRATION_ANTHROPIC_MODEL`后才注册。model仍必须与已审批binding相同，启用Worker不等于批准某次费用。

本地真实 PostgreSQL + Redis 门禁：

```bash
pnpm test:eval-queue:local
```

该命令同时保留既有Redis delivery/grader测试，并以两个真实non-owner PostgreSQL角色启动`all`runtime，验证职责内队列链路与职责外访问拒绝。live sampler列级权限canary包含在`pnpm test:db:postgres:local`。
