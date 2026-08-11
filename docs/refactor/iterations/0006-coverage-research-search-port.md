# Iteration 0006：Coverage/Research 与 Search Port

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R4 TS Agent core
- 对应决策：[ADR-0004](../decisions/0004-evaluation-first-migration.md)、[ADR-0006](../decisions/0006-agent-core-model-port-and-invalid-output.md)、[ADR-0007](../decisions/0007-search-port-and-research-outcomes.md)

## 目标

把 Python Opinion/Search 的领域输入输出迁入 TypeScript Agent core，拆分“章节覆盖点规划、查询策略、外部搜索、来源排序、资料提炼”，并建立不发真实网络请求的共享 component dataset，为 Writer/tool loop 和后续 citation/memory/eval 留下稳定边界。

## 范围内

- `CoveragePlannerService`、严格 model output schema 和 prompt version；
- `SearchRequest`、`SearchDocument`、`SearchProviderResponse` Zod contracts；
- `SearchProvider` port、抛出式 typed provider error、结果映射与 AbortSignal；
- 可注入 clock 的 news/general 查询策略；
- 可追溯来源格式、确定性排序和 `ResearchService`；
- `ready | empty | unavailable | failed` Research 结果；
- Python compatibility 与 TS target 共用的 Opinion/Search fixture；
- component eval 与系统/决策/迭代文档同步。

## 范围外

- 不安装 Tavily JS SDK，不实现真实 provider adapter，不发网络请求；
- 不迁移 Writer tool loop、diagram tool、完整 graph 或 LangGraph.js；
- 不接入 Worker、BullMQ、PostgreSQL、SSE 或生产 trace；
- 不切换 Python 运行时；
- 不宣称文章研究质量、来源权威性或模型提炼质量等价；
- 不把搜索结果自动写入长期 memory 或 RAG。

## 必须证明的行为

1. Coverage plan 只接受成对、非空、合法的覆盖点与查询；
2. 无效 Coverage output 显式 inconclusive；
3. 查询分类、历史年份、日期上下界和 as-of date 可确定重放；
4. 搜索来源保留 URL、title、发布时间、score 和 provider metadata；
5. 排序规则对无日期来源有明确策略；
6. provider unavailable、failure、empty 与 success 不混为字符串；
7. 无结果不调用提炼模型；
8. provider/model 都收到同一 AbortSignal，取消异常不会降级为普通 failed；
9. Python 和 TS 读取同一 fixture，并把 intentional delta 与 regression 分开；
10. Agent core 继续不导入 runtime/vendor 基础设施。

## 当前实现

- `packages/contracts/src/research.ts`：provider-independent search wire/domain contracts；
- `packages/agent-core/src/coverage.ts`：客观覆盖点规划和严格解析；
- `packages/agent-core/src/research.ts`：查询策略、SearchProvider port、排序、来源格式和提炼；
- `packages/contracts/fixtures/opinion-search-baseline.json`：5 个 Coverage、4 个查询策略、2 个排序 case；
- Python fixture test 固定 compatibility，TS test 固定 target 与 component orchestration。

## 行为差异

| 情况 | Python compatibility | TypeScript target |
|---|---|---|
| 合法成对列表 | 两个平行数组/格式化字符串 | `CoveragePoint[]` | 结构化等价 |
| Coverage 非法 JSON/空列表 | 空字符串与空查询 | inconclusive | intentional safety delta |
| Coverage 成员非法或长度不等 | 独立过滤后继续 | inconclusive | intentional safety delta |
| general 日期窗口 | 向 SDK 传 `days=365` | `startDate=asOf-365d, endDate=asOf` | deterministic request-shape delta |
| 明确历史年份 | 任意 `20xx` 触发 news/近 90 天 | general + 该年份绝对范围 | historical retrieval safety delta |
| 很旧的 dated news 与 undated | undated 可能在旧 dated 前 | 所有合法 dated 来源优先 | provenance delta |
| 搜索失败 | 空字符串/中文提示 | unavailable/failed + reason/retryable | intentional observability delta |
| 成功资料 | 仅提炼字符串，snippet 无 URL | summary + structured sources | intentional provenance delta |

## 验证证据

```bash
API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify
git diff --check
```

| 范围 | 结果 |
|---|---|
| contracts | 2 个文件、16 项测试；typecheck 通过 |
| model-runtime | 1 个文件、8 项测试；typecheck 通过 |
| agent-core | 3 个文件、54 项测试；typecheck 通过 |
| DB | 1 个文件、8 项测试；typecheck 与 migration check 通过 |
| Python API | 48 项 pytest 全部通过 |
| Web | lint、6 个文件/12 项测试、Next.js production build 通过 |
| 文档/工作树 | 25 份 Markdown 相对链接有效；`git diff --check` 通过 |

首次窄验证发现测试期望与新排序规则不一致：测试原把一条更旧但有合法日期的来源预期排在无日期来源之后。按照 ADR-0007 的“所有合法 dated 来源优先”规则修正测试输入。独立代码读者随后发现 cancellation、endDate、时区日期、失败 provenance、历史年份及混合年份范围缺口；补实现和回归测试后，agent-core 增至 54 项并通过窄验证。最终全量 verify 在全部读者修正后重新运行。

## 回滚

当前没有运行时接线。回滚只需移除新增 TS contract/core、fixture/test 和本迭代文档，并恢复 package export/dependency 与索引；Python 生产路径不受影响。共享 Python fixture test 只读旧实现，不改变生产行为。

## 剩余风险与下一步

- SearchProvider 仍没有真实 Tavily adapter、timeout/retry/rate-limit/response-validation 集成测试；
- Research model error 已映射为 distillation-stage failed，取消继续抛给任务生命周期；graph 尚未定义 retry/terminal policy；
- fixture 只覆盖确定性结构，不判断来源相关性、权威性、摘要忠实度或 citation correctness；
- Writer 仍使用 Python `search_fn: (query) -> string`，尚未消费结构化 ResearchResult；
- Coverage inconclusive 尚未定义 graph 的有限重试、降级或终止策略；
- 下一迭代迁移 Writer/tool loop 时，需要为 tool result 建立 schema/version、轮数预算、失败渲染、来源引用和取消测试。

## 独立读者测试

三位无对话背景读者分别审查架构、eval 与代码。首轮/closure review 发现并推动修复：

- 明确当前没有真实 Tavily adapter、Worker 接线或运行时切流；
- 收窄“可替换”“provider correctness”和 provenance 的过度表述；
- provider/model failure 映射与 cancellation 生命周期分离；
- 增加 endDate、未来来源过滤、带时区发布时间和非 ready provenance；
- 修正历史年份及历史/当前混合查询范围；
- 把 Python compatibility 从状态断言升级为精确输出；
- 增加 dataset status/date/permutation/unique-id 不变量与负例；
- 明确 URL 到未来内部 source id 的演进和 dirty checkout 可复现性限制；
- 补齐最终 artifact hash、专属测试计数和全量验证证据。

最终 closure review 的功能、架构与 eval 问题均已关闭；随后对当前最终文件重新运行 `pnpm verify`、文档链接检查和 `git diff --check`。
