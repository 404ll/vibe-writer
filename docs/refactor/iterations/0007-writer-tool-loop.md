# Iteration 0007：Writer 与有界 Tool Loop

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R4 TS Agent core
- 对应决策：[ADR-0004](../decisions/0004-evaluation-first-migration.md)、[ADR-0006](../decisions/0006-agent-core-model-port-and-invalid-output.md)、[ADR-0007](../decisions/0007-search-port-and-research-outcomes.md)、[ADR-0008](../decisions/0008-writer-tool-loop-and-tool-model-port.md)

## 目标

把 Python Writer 的 prompt、token budget、search/diagram 工具和 `BaseAgent` 工具循环迁入供应商无关的 TypeScript Agent core，并用共享 fixture 固定协议、预算、错误与不完整终态，为 LangGraph.js 组图和后续 memory/eval 工具建立可复用边界。

## 范围内

- `ToolModel` request/response、message block、tool definition 与 stop reason port；
- `ToolLoopRunner` 的 transcript、call id、结果顺序、可 checkpoint 预算、取消和失败语义；
- Writer prompt/style/token budget、diagram/search 工具及版本；
- 从同一 Zod schema 生成 provider JSON Schema 并执行严格 runtime validation；
- Research summary/citation 渲染与结构化 provenance；
- Python compatibility 与 TS target 共用的 Writer/tool-loop fixture；
- component eval、ADR、系统设计和迭代文档同步。

## 范围外

- 不实现 Anthropic、OpenAI 或 LangChain 的真实 ToolModel adapter，不发模型或搜索网络请求；
- 不实现 LangGraph.js graph、Worker、BullMQ、checkpoint、SSE persistence 或生产 trace；
- 不切换 FastAPI/Python 运行时；
- 不实现 token streaming；
- 不声称正文质量、引用忠实度、真实供应商协议或成本已经等价；
- 不把 transcript、工具结果或来源自动写入长期 memory/RAG。

## 必须证明的行为

1. tool call 与 tool result 一一对应、顺序稳定且结果紧跟 call；
2. 空/重复 call id 和协议矛盾显式 inconclusive；
3. 工具轮次、总 dispatch 与 search dispatch 都有独立上限，预算可跨重写传递；
4. 未知工具、非法输入、handler/tool error 和预算耗尽有结构化 outcome；
5. handler 错误不会向模型泄漏原始异常，外部取消不会被降级，内部 `AbortError` 不误判取消；
6. `max_tokens`、`refusal`、`pause_turn`、空文本与轮次耗尽不伪装为成功；
7. Zod runtime schema 与 provider JSON Schema 由注册边界同源生成且禁止额外字段；
8. Writer prompt、toolset、字数预算和可选 search 与 Python 基线可解释对照；
9. Research tool result 保留 citation/provenance，不携带原始 source content；
10. Python 与 TS 读取同一 fixture，并把 intentional delta 与 regression 分开。

## 当前实现

- `packages/model-runtime/src/tools.ts`：供应商无关 ToolModel 协议；
- `packages/agent-core/src/tool-loop.ts`：有界、可观测、可取消的工具循环；
- `packages/agent-core/src/writer.ts`：WriterService、可跨重写预算、严格工具 schema 和 Research 渲染；
- `packages/agent-core/src/prompts.ts`：与 Python 对照的章节 prompt/style；
- `packages/contracts/fixtures/writer-tool-baseline.json`：8 个共享 compatibility/target case；
- `packages/agent-core/tests/writer-tool-loop.test.ts` 与 Python fixture test：目标行为和旧实现对照。

## 行为差异

| 情况 | Python compatibility | TypeScript target | 分类 |
|---|---|---|---|
| 普通最终正文 | 返回正文 | `ready` + 正文 | 结构化等价 |
| search/diagram tool result | Anthropic block + 字符串 | provider-neutral block + outcome/provenance | protocol abstraction delta |
| handler 异常 | 原始 `Error: ...` 发回模型 | 安全提示 + `handler_error` | security delta |
| 非法 tool input | handler 可能报错 | Zod 拒绝 + `invalid_input` | validation delta |
| 工具轮次耗尽 | 返回空字符串 | 允许一次 finalization；仍请求工具则 inconclusive | completion safety delta |
| `tool_use` 无 call | 继续下一轮 | `invalid_model_response` | protocol safety delta |
| 最终文本为空 | 返回空字符串 | `empty_final_text` | observability delta |
| search 预算 | graph closure 最多 3 次 | tool registry 每章最多 3 次 | ownership delta |

## 验证证据

```bash
API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify
git diff --check
```

| 范围 | 结果 |
|---|---|
| contracts | 2 个文件、18 项测试；typecheck 通过 |
| model-runtime | 1 个文件、9 项测试；typecheck 通过 |
| agent-core | 4 个文件、92 项测试；typecheck 通过；Writer/tool-loop 专属 35 项 |
| DB | 1 个文件、8 项测试；typecheck 与 migration check 通过 |
| Python API | 49 项 pytest 全部通过 |
| Web | lint、6 个文件/12 项测试、Next.js production build 通过 |
| 文档/工作树 | 28 份 Markdown 相对链接有效；`git diff --check` 通过 |

窄验证先发现 observer callback 隐式返回 `Array.push()` 的 number，修正为 void callback；随后把 tool JSON Schema 改为从 strict Zod schema 生成，并增加总预算先于 known/unknown dispatch 的回归测试。独立读者进一步发现空白正文、跨重写预算、adapter mutation、取消分类、observer 隐私、模型调用 provenance 和 dataset 可证伪性缺口；全部补实现与回归测试后，Agent core 增至 92 项。完整验证在这些修正后重新运行。artifact hash、环境和 dirty worktree 的可复现性边界见 [Eval 0003](../evals/0003-writer-tool-loop-deterministic-baseline.md)。

## 回滚

当前没有运行时接线。回滚只需移除新增 ToolModel/Writer/tool-loop、fixture/test、package export 和本迭代文档；Python 生产路径不受影响。

## 剩余风险与下一步

- 真实 provider adapter 仍需验证 stop reason、usage、timeout、重试、并行 tool call 和 malformed response 映射；
- graph 尚未定义 Writer inconclusive、模型错误和 Research failure 的 retry/terminal policy；
- started/finished event 尚未进入 durable event/outbox 或 trace；
- fixture 不评估正文、diagram 或 citation 的语义质量；
- 下一迭代应组装 LangGraph.js 的显式状态、checkpoint 与节点级 policy，再做 Python/TS shadow component/e2e 对比。

## 独立读者测试

三位无对话背景读者分别审查架构、代码与 eval。首轮发现并推动修复：

- 空白正文不能成为 ready；内部 timeout `AbortError` 与外部取消必须区分；
- `ToolBudgetUsage` 必须跨重写传递，attempted call 与 dispatched call 必须分开描述；
- adapter 不能修改内部 transcript 或共享 tool schema，注册类型只能有一份 Zod schema；
- 单工具预算必须拒绝 `NaN`、Infinity、负数和小数；tool metadata 必须是递归 JSON 类型；
- model usage/request id 不能丢失，默认 observer 必须 metadata-only 且 best-effort；
- dataset 必须机器标注 5 个 intentional delta，并精确冻结 Python legacy 泄漏与 TS 脱敏；
- 补齐 refusal/pause、finalization 再次调用、tool error、矛盾 stop reason、finished observer 和跨重写 search budget 测试。

closure review 确认上述架构、代码和 eval 问题均已关闭；随后对当前最终文件重新运行专属测试、`pnpm verify`、文档链接检查和 `git diff --check`。
