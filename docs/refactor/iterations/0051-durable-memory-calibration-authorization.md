# Iteration 0051：Durable Memory Calibration Authorization

- 日期：2026-08-09
- 状态：Done
- 对应决策：[ADR-0052](../decisions/0052-durable-memory-calibration-authorization.md)
- 评测记录：[Eval 0047](../evals/0047-durable-memory-calibration-authorization-baseline.md)

## 目标

把Iteration 0050的进程内approval升级为PostgreSQL-owned授权与审计事实，并在不复制任务系统的前提下接入现有独立Eval queue。

## 范围内

- 共享strict model execution binding与pricing parser/fingerprint；
- workspace-owned authorization、append-only event ledger、migration与RLS；
- owner-only register/approve/enqueue、exact replay和collision语义；
- suite/cases、authorization、queued Eval run和outbox的事务边界；
- 按run id重载authorization的Memory calibration queue executor；
- dataset/binding/execution/report identity fail-closed；
- 默认关闭的Anthropic Worker composition与operator CLI；
- PGlite、真实PostgreSQL RLS和scripted 72-trial证据。

## 范围外

- 不选择或批准真实model、pricing snapshot与费用；
- 不读取现有credentials，不发起真实provider调用；
- 不把scripted quality pass解释为真实calibration Go；
- 不实现invoice reconciliation、管理UI或automatic uncertain resolution；
- 不把production Memory consumer打开。

## 验证

- `pnpm test:eval-core && pnpm typecheck:eval-core`：4个文件、10项测试与类型检查通过；
- `pnpm test:eval-graders && pnpm typecheck:eval-graders`：1个文件、5项测试与类型检查通过；
- `pnpm test:eval-cli && pnpm typecheck:eval-cli`：11个文件、47项测试与类型检查通过；
- targeted DB：architecture与authorization共19项通过；
- `pnpm test:db:postgres:local`：DB 20、checkpoint 4、live sampler 1及Eval registration/enqueue replay通过；
- 根级`pnpm verify`：contracts 25、model runtime 9、provider runtime 11、Eval core 10、Eval graders 5、Memory core 26、Eval CLI 47、Agent core 93、workflow runtime 48、DB 119、checkpoint 8、Worker 78、API 50、Web 31及Next production build全部通过；
- `pnpm check:docs`：163个Markdown文件链接通过；`git diff --check`通过。

## 退出条件

1. approval由owner和数据库时间产生，绑定不可变fingerprint：满足。
2. 未审批任务不能入队，指纹漂移不能审批或入队：满足。
3. run/outbox/link/event在同一事务创建且重复enqueue复用同一run：满足。
4. authorization/event按workspace RLS隔离，事件对应用role不可更新或删除：满足。
5. Worker从durable authorization重建manifest并核对完整identity：满足。
6. scripted queued executor完成24×3且report不捕获output：满足。
7. 真实provider与production状态保持默认关闭：满足。

## 后续

1. operator选择真实model，保存可追溯的官方pricing snapshot并先运行quote；
2. owner审查72-call最高费用和binding fingerprint后，分别执行register、approve、enqueue；
3. 真实运行后人工核对quality distribution、usage、request/response identity与账单；
4. 在request-level terminal evidence缺失时，crash/unknown outcome保持人工hold；
5. 再推进staging Memory consent API、expiry scheduler、shadow consumer与retrieval/answer-uplift Eval。
