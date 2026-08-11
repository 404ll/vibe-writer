# Eval 0004：Workflow Runtime 确定性基线

- 日期：2026-08-07
- Dataset：`workflow-control-baseline-v1`
- Dataset schema：1
- Python baseline：`python-c47cbfd0ab1f`
- TypeScript graph：`writer-graph-v1-target-2026-08-07`
- LangGraph.js：`1.4.9`

## 评测范围

共享 dataset 位于 `packages/contracts/fixtures/workflow-control-baseline.json`，由 Zod schema 校验。Python `should_rewrite()` 与 TS `fullReviewDecision()` 分别读取同一组全文审稿 route case；TS 另外读取 Writer inconclusive policy case。

Scripted LangGraph component tests 覆盖：

- 无人工介入的 happy path 与无副作用 export intent；
- MemorySaver + thread id 下的 outline interrupt、编辑、文字 revise、再次 interrupt 和 confirm resume；
- 同一 MemorySaver 重建 graph 后 resume，plan/revise 不重复调用；
- 从第一章完成 checkpoint replay，第一章 coverage/write/light-review 不重复，后续章节重新执行；terminal checkpoint 重入不执行任何节点；
- 轻审重写继承同章 `ToolBudgetUsage`；
- Planner、Coverage、Writer、chapter review、full review 的 inconclusive/非法返回/service exception 有限重试和显式 failure；
- 全文只重写 failed chapter，第二轮仍 failed 时产生 quality warning；
- 初始/中间 checkpoint/completed/failed 应用 state JSON round-trip 与语义 invariant、graph/package dependency boundary。

## 共享 fixture 机器评测

| 行为 | Python compatibility | TypeScript target | 分类 |
|---|---|---|---|
| 全文全部通过 | export | export | 等价 |
| 第一轮有失败 | write | rewrite failed chapter | 可观测等价 |
| 第二轮仍失败 | 静默 export | export + quality warning | intentional observability delta |

只有上表三项由 Python 与 TypeScript 读取同一 fixture 双端断言。Writer retry policy 是 TS target-only dataset，不声称 Python 等价。

## 已实现但不属于共享 compatibility fixture 的设计差异

| 行为 | Python 当前实现 | TypeScript target | 本 Eval 的证据边界 |
|---|---|---|---|
| 大纲确认 | plan node 阻塞进程内 Event | 独立 interrupt node + Command resume | TS MemorySaver scripted test；未做 Python/TS 双运行 |
| 章节执行 | 单个 write node 内并行全部章节 | 逐章 checkpoint | TS 中间 checkpoint replay；未测生产并发/吞吐 |
| export | graph node 写文件和 SQLite | 只生成 Markdown + idempotent intent | TS 输出与依赖边界 test；未接 Worker transaction |

这三行来自 Python graph 代码审计、TS scripted graph test 与依赖边界测试，不是共享 fixture 的双运行对比；因此不能读作“已证明生产等价”。

## 当前结果

- 共享 rewrite route：3/3 Python compatibility 通过，3/3 TS target 通过；
- Writer policy case：10/10 TS target 通过，完整覆盖四类 retryable reason 的 attempt 1/2 边界及两类立即 terminal reason；
- workflow-runtime：2 个测试文件、47 项测试通过，typecheck 通过；
- 实际 checkpoint replay：MemorySaver、固定 thread id、同一 saver 重建 graph；中间 chapter checkpoint 与 terminal checkpoint 均通过；
- 真实模型、PostgresSaver、Worker、provider、网络、重启恢复和 LLM grader：未运行。

## 运行 provenance

- Git base revision：`c47cbfd0ab1f05630f189c9aecfe0ab8ec50033f`
- Worktree：dirty，最终验证时共有 52 个 tracked/untracked 状态项；本轮没有 commit，因此 base revision 不能独立恢复这份 TypeScript patch
- Node.js：`v22.14.0`
- pnpm：`10.0.0`
- Python：`3.14.5`
- LangGraph.js：`1.4.9`（pnpm 实际解析版本）

相关 artifact SHA-256：

| Artifact | SHA-256 |
|---|---|
| `packages/contracts/src/workflow-component-fixtures.ts` | `fdf532b688a4e10535b9ee2103826817b270291d685d66a2aa39f9cf95ab20ed` |
| `packages/contracts/fixtures/workflow-control-baseline.json` | `bc0b951344d6e88c58fc9c597d8a84bed2aa9e71e5be6b8ab4f238054c59df83` |
| `packages/contracts/src/fixtures.test.ts` | `cd8c6ecb6ab87564b3548f1f44b2185a6a4ddcda439ccb7111cc1563cd957857` |
| `apps/api/backend/agent/graph.py` | `d49d515fb6bbf2bb1a9c8dd0437c1483f6bde6c7231b9b98bfed2a474bf1c154` |
| `apps/api/tests/test_agent_component_fixtures.py` | `7585be6cda6864cfc168a32469f3ec6f73aa77be0b705a40fe2127232c58f17f` |
| `packages/workflow-runtime/src/state.ts` | `09ed36c5389b63648d00daad874fbe6ecf54d7f2d859cae036a3e345c22b95f5` |
| `packages/workflow-runtime/src/policy.ts` | `bcf163bb0ee1ddc727b66c72fa6f55dae2edb7f2847178686a51838e760925cc` |
| `packages/workflow-runtime/src/graph.ts` | `151e36cf2b03466b4c1b90c37f43139a952121bd7ef7cee3a51444cb7916e902` |
| `packages/workflow-runtime/tests/workflow.test.ts` | `c5c0c340a2a8a24ceee6d3615b62ee8887dd4ab35bc752f1d36a295f772c2981` |
| `packages/workflow-runtime/tests/architecture.test.ts` | `568c5f03c6eb574c4648524628b6e7b38f337621465746f272db4791d211d0b6` |
| `packages/agent-core/src/writer.ts` | `f1998433bcc78b76ab540fa1edeaec371e02b11b9ce71e63528bea23d6b5e7cb` |
| `packages/agent-core/src/tool-loop.ts` | `9a409d789fcdb7f73273433ed1d5b6a2b912348fbe7781579e6eef3d212cfd07` |
| `package.json` | `d0df88acfaf8aeafd9d1bf3c4735b8e4375f53d19fdce1682ec1ee4c8e051cdb` |
| `pnpm-workspace.yaml` | `08d75840c97ab0e72d1d9b5b84a17e47a2e06cb159a5fbec5ee0a6a56682dad7` |
| `packages/workflow-runtime/package.json` | `61063310565fa99974c0d64896f0b211b8e10f1544cb8d12c563aeca4cca24e7` |
| `pnpm-lock.yaml` | `239e32dc0cf719710c28588629600dba23a6c16dd184ccf7f958ec5acd790cf5` |
| `apps/api/requirements.txt` | `c95e73f9c0cb0dd34e793991c5e2aa8e685412f9466c6fb47f5d658a03a182f6` |

最终命令：

```bash
API_PYTHON=/absolute/path/to/.venv/bin/python pnpm verify
git diff --check
```

两条命令均以 0 退出。全仓最终结果：contracts 19、model-runtime 9、agent-core 92、workflow-runtime 47、DB 8、Python API 50、Web 12；相关 TypeScript typecheck、Drizzle migration check、Web lint、Next.js production build和 31 份 Markdown relative-link check 全部通过。Python 仍产生 2572 条既有 asyncio/FastAPI/`utcnow()` deprecation warning。

专属计数需分开理解：共享 workflow fixture 有 3 个 rewrite route case 和 10 个 TS-only Writer policy case；Python 专属文件是 9 个 pytest item，其中 workflow route 作为一个 item 循环断言 3 个共享 case；workflow-runtime 是 2 个测试文件、47 个 Vitest item。

独立读者 closure：架构、代码和 Eval 三类只读复核均完成。初审暴露的无限 Coverage 循环、service exception 不计 attempt、伪 checkpoint replay、隐式 outline 确认、重写计数混用、版本/provenance 与 Eval 过度声明均已修正或明确进入 R5；最终代码读者复核返回 `closure passed`。

### 可复现性边界

当前 worktree 未提交，artifact hash 只能核对当前 checkout，不能从 Git 独立取回这份 patch。真正可独立重建的 code revision 必须是后续用户授权提交后的 commit SHA；Python 依赖仍含宽版本范围，完整环境重建还需要后续 lock/freeze 记录。

## 不代表什么

- MemorySaver 只能证明同进程 saver 的 interrupt/checkpoint/replay 行为，不能证明进程重启后恢复；
- scripted services 不能证明真实模型质量、timeout/retry 或 provider correctness；
- 非取消类 service exception 已计入领域 attempt，但进程在付费调用完成后、checkpoint 前崩溃仍可能重复调用；
- graph 尚未接 JobRepository、article/version transaction、SSE projection 或 BullMQ；
- 应用 state JSON round-trip 不代表 LangGraph checkpoint envelope/Postgres serializer 已验证；
- execution config 默认仍为 `prototype-unbound`，没有证明生产版本 registry 或旧 checkpoint migration；
- checkpoint 隐私、容量、TTL/删除级联及 durable run-record projection 尚未完成；
- 逐章执行的吞吐尚未与 Python 并行写作比较；
- 这不是生产切流证据。
