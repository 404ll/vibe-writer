# ADR-0034：Approved Live Eval Dataset Materialization

- 状态：Accepted
- 日期：2026-08-07

## 背景

自动 sampler 只生成 content-free pointer，`approved` 也只代表 workspace reviewer 同意后续处理。Eval runner 需要实际输入才能执行，但直接让 generic `createSuite()` 接受 `user_content` 会绕过 candidate、source freshness、retention 和删除传播；增量修改一个 active suite 又会破坏 immutable dataset fingerprint。

## 决定

1. 新增 owner-only materialization repository。一次命令显式给出 1–100 个 approved candidate、suite key/version 和 materializer key/version；所有 candidate 必须属于当前 workspace 且由同一事务按 id 加锁。
2. materializer 在唯一允许读取正文的边界内重新读取 current article，并逐项校验 job/article identity、revision 与 content fingerprint。任何 source 已修改、缺失、过期、跨 workspace 或状态不一致都会使整批回滚。
3. 一批 candidate 原子生成一个 workspace-owned、immutable fingerprint 的 `draft` suite 和对应 `user_content` cases。case 保存 source candidate、retention deadline 和 materializer identity；candidate 转为 `materialized` 并追加 machine-readable event。重放必须命中同一 suite/cases，否则 fail closed。
4. generic `EvalRepository.createSuite()` 不再接受 `user_content`；synthetic 和调用方已明确分类的 `deidentified` dataset 保持原路径。当前 materializer 是 versioned approved article copy，不声称已去标识化，所以 classification 必须保持 `user_content`。
5. draft suite 需要 workspace owner 再次显式 activate。activation 会重算 case/input/dataset fingerprint，并重新校验 candidate 状态与数据库时间 retention；active replay 也执行相同检查。
6. `startRun`、queued claim context 和 queued report commit 都重新验证 immutable fingerprint、live candidate 状态和 retention，避免 enqueue 后内容过期仍被执行或提交。
7. materialized candidate 到期时，同一事务 archive suite、删除含正文的 case，再写 expired event；source job/candidate 删除通过 FK cascade 删除 case。留下的空/变化 suite 会因状态或 fingerprint gate 无法再运行。
8. `eval_cases/eval_runs/eval_trials/eval_scores` 全部启用基于 parent workspace 的 PostgreSQL RLS。service role 可做受信 maintenance；普通 API role 无 scope 时必须看不到 dataset 和结果树。

## 结果与限制

系统现在有明确的 `sampled → approved → materialized → active dataset` 权限链，正文只在 owner 再授权后进入 draft dataset，并能随 retention/source deletion 清理。suite 版本和 materializer 版本可审计，batch 失败不会产生半套 dataset。

本轮 materializer 不去标识化、不提取 expected answer、不调用 grader，也没有 API/UI、异步 materialization queue、加密字段或备份清理证明。case 上限为 1 MiB，超过时 fail closed；未来需要 chunk/redaction 时必须提升 materializer version，不能静默改变现有 suite。
