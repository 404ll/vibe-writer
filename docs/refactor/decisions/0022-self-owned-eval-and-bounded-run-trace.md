# ADR-0022：自有 Eval 数据平面与有界 Run Trace

- 状态：Accepted
- 日期：2026-08-07

## 背景

迁移基线已经通过 fixture、测试和 `docs/refactor/evals` 记录保存，但还没有统一、可执行的 Eval 协议，也没有可查询的 suite/case/run/trial/score 数据模型。`run_effects` 能围栏 provider 副作用并保存少量 metadata，却不能替代 Trace：它的首要职责是幂等和 uncertain 恢复门禁，而不是实验分析、token 聚合或 vendor export。

Memory、持续 Eval 和线上回归都需要稳定的 run identity、版本快照和可查询的执行元数据。如果直接把这些事实只写入 Langfuse，核心历史会受外部产品 schema、保留策略和可用性约束；如果默认持久化 prompt、response 和 tool result，则会扩大用户正文和搜索内容的数据面。

## 决定

1. 新增供应商、数据库和队列无关的 `@vibe-writer/eval-core`。离线 runner 固定 dataset、target、model profile、prompt、graph、tool 和 code revision，并把 target error 与 evaluator error 分层记录。
2. dataset fingerprint 对按 case key 排序后的 input、expected 和 tag 做 canonical SHA-256；suite identity 是 `namespace_key + suite_key + version`。相同版本只能精确重放，dataset 变化必须提升版本。
3. runner 默认不把 case input、expected 或 output 写进 report，只保存 output fingerprint。保存 output 必须显式启用，由调用方承担授权、脱敏、访问控制和 retention。
4. PostgreSQL 自有 `eval_suites → eval_cases → eval_runs → eval_trials → eval_scores`。suite/case 是可导出的数据真相；Langfuse 等平台未来只通过 adapter 接收副本，不能成为唯一事实来源。
5. Eval suite 必须带 opaque `namespace_key` 和 `data_classification`。当前允许 `system` 或调用方提供的 workspace-like key，但它不替代尚未决定的 auth/tenant schema；公开多租户流量仍为 No-Go。
6. 每个 durable run 的 `trace_id` 必填。外部 effect reservation 在同一 PostgreSQL transaction 创建一个 `trace_span`；effect finish、lease takeover 和 terminal cleanup 在同一 transaction 完成或标记 span uncertain。
7. Trace 只保存 operation、effect fingerprint、provider/model/request id、token、latency、finish/stop reason、document count 和结构化错误。prompt、messages、query、URL、snippet、tool body、响应正文和 secret 不进入 span。
8. `run_effects` 与 `trace_spans` 保持不同职责：前者决定外部副作用能否执行与重放，后者服务查询、聚合、Eval 关联和未来 observability export。Trace 写入失败会使 effect transaction 失败，不能静默丢失审计记录。
9. target 成功而 grader 失败时，trial 保持 succeeded、score 标为 error，最终 eval run 为 failed；禁止把 grader 故障伪装成模型质量失败或通过。

## 不变量

- 一个 run 只有一个稳定 `trace_id`；一个 `run_id + span_key` 最多一条 span。
- 没有成功的 effect reservation，就没有 running provider span，也不能发送 provider 请求。
- running span 在 run terminal/takeover 后必须进入终态，不能永久冒充正在执行。
- Eval run 只有在 `case_count × trials_per_case` 全部记录后才能完成。
- grader error、target error 和 inconclusive 必须可区分，任何 error 都不能被聚合成通过。
- 默认 trace/eval report 不扩散用户正文。

## 明确限制

- 当前 Trace 只覆盖 fenced model/search/tool/export effect；尚无 LangGraph node、HTTP 或 queue span。
- 当前 Eval runner 是进程内离线协议，尚未接独立 BullMQ eval queue、CI baseline gate、shadow sampler 或 live provider dataset。
- `namespace_key` 只是前置隔离字段；没有 auth principal、workspace foreign key、RLS 和访问控制前，不得声称多租户安全。
- `user_content` classification 已可表达，但 production retention/consent policy 尚未实现，因此不得把生产正文批量注册为 dataset。
- Langfuse adapter、自托管/云选择、trace sampling 和 vendor retention 仍待后续 ADR。

## 未选择

- 只使用 Langfuse dataset/trace：会把可重放数据和版本事实外包给 vendor。
- 继续把 `run_effects` 当 Trace：JSON metadata 难以查询，且会混淆恢复协议和分析数据。
- 默认保存完整 prompt/transcript：不符合最小数据面原则。
- grader 抛错时忽略该 score：会制造虚假绿色结果。
