# Iteration 0019：Readiness 与切流控制

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R5 Worker/API cutover
- 对应决策：[ADR-0020](../decisions/0020-readiness-and-atomic-api-article-cutover.md)
- 运维入口：[Durable切流Runbook](../runbooks/durable-cutover.md)

## 目标

把“production composition能运行”推进为“部署系统能判断何时接流量”，并消除浏览器API与文章Server Component读源分裂的切流风险。

## 范围内

- Next durable live/ready Route Handler；
- schema-aware PostgreSQL readiness；
- Worker可选HTTP live/ready与starting/ready/draining状态；
- Worker启动前DB ping、依赖就绪顺序和关闭退流顺序；
- 独立article read-source runtime flag；
- durable build + API/Worker probes + Server Component联合E2E；
- 切流/回滚runbook、ADR与Eval。

## 范围外

- 不实际切换用户流量；
- 不实现auth/session、tenant namespace或公开访问；
- 不迁移SQLite article/version数据；
- 不执行真实provider quality eval；
- 不验证托管负载均衡器、Kubernetes probe、kill -9或网络分区。

## 实现结果

- API liveness不查询依赖；readiness只有在feature enabled、PostgreSQL可连接且10张durable业务表存在时返回200，错误不泄露内部细节。
- Worker仅在显式配置health port时监听；DB ping、PostgresSaver、publisher和consumer全部完成后才ready，close开始先进入draining。
- `DURABLE_ARTICLE_READ_ENABLED=false`默认保留FastAPI读源；true时Server Component直接使用PostgreSQL article repository。
- `.env.example`和runbook把build-time client base、runtime API flag与article read flag定义为原子发布单元。
- 联合harness现在除Worker链路外，还以 `/api/durable` 构建并启动Next，验证API readiness、durable article list和Server Component PostgreSQL渲染。
- runbook明确公开切流仍受auth/tenant、数据迁移和live/shadow eval阻塞，未把staging成功表述为production ready。

## 验证证据

- `pnpm test:worker`：49/49；配置与lifecycle顺序回归通过。
- `pnpm typecheck:worker`：通过。
- `pnpm test:web`：27/27；health route与article source切换测试通过。
- `pnpm build:web`：通过，输出两个health Route Handler。
- `pnpm test:worker:production:local`：1/1；真实PostgreSQL+Redis、Worker health、durable Next build、API readiness和Server Component article读取全部通过，临时服务已停止。
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：contracts 20、model 9、provider 5、agent 93、workflow 48、DB 47、checkpoint 8、Worker 49、Python API 50、Web 27；migration、lint、build和65份文档链接全通过。
- `git diff --check`：通过。完整结论见 [Eval 0015](../evals/0015-readiness-cutover-baseline.md)。

## 遗留边界

- health只说明当前实例与依赖就绪，不说明文章质量、积压健康或数据一致性；canary与指标门禁仍必须运行。
- auth/tenant与SQLite backfill是公开切流硬门槛，不能用feature flag代替。
- Worker health默认不监听；部署manifest必须显式设置端口并配置独立live/readiness probe。
- OS signal与网络故障注入仍待process-level staging harness。
