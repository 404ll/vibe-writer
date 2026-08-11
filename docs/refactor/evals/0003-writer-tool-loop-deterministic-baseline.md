# Eval 0003：Writer/Tool Loop 确定性基线

- 日期：2026-08-07
- Dataset：`writer-tool-baseline-v1`
- Dataset schema：1
- Python baseline：`python-c47cbfd0ab1f`
- TypeScript agent core：`agent-core-v1`
- Writer prompt：`writer-v1-target-2026-08-07`
- Writer toolset：`writer-tools-v1-target-2026-08-07`

## 运行 provenance

- Git base revision：`c47cbfd0ab1f05630f189c9aecfe0ab8ec50033f`
- Worktree：dirty，评测时共有 52 个 tracked/untracked 状态项；本轮没有 commit，不能只用 base revision 复现 TS patch
- Node.js：`v22.14.0`
- pnpm：`10.0.0`
- Python：`3.14.5`

相关 artifact SHA-256：

| Artifact | SHA-256 |
|---|---|
| `packages/model-runtime/src/json.ts` | `a0bd2d88bb61e05deadcca37a8606a2ca719afc9691c0010f198d4558bc35f7d` |
| `packages/model-runtime/src/tools.ts` | `662ab2e33d12daf93864f9196065d5fbe7ea212c969f4cac5865402d9d010ffd` |
| `packages/agent-core/src/tool-loop.ts` | `9a409d789fcdb7f73273433ed1d5b6a2b912348fbe7781579e6eef3d212cfd07` |
| `packages/agent-core/src/writer.ts` | `f1998433bcc78b76ab540fa1edeaec371e02b11b9ce71e63528bea23d6b5e7cb` |
| `packages/agent-core/src/prompts.ts` | `a9b71d723daa27a97b25f1b79e98cfb46c541200844d81bc62441738667afffe` |
| `packages/agent-core/src/versions.ts` | `7404d4f74e165c23e2ed476a1fbd4311b11638dea93f3545ed55b21ca25440b3` |
| `packages/contracts/src/writer-component-fixtures.ts` | `7d663b9f4f59c3bf9aff90780751068e8da60ed38b5c257dffd1001231269ae1` |
| `packages/contracts/fixtures/writer-tool-baseline.json` | `f219a7e83d6cc228b953594ba9f74d55550012ab183f7552ad617be6d953a205` |
| `packages/agent-core/tests/writer-tool-loop.test.ts` | `f0bae18bcc68663d10f65073229d9a2f3a16cd9bfce7731d627830d478df24f6` |
| `packages/contracts/src/fixtures.test.ts` | `dec813445ab1ca8b8c72ec054b98f63dac4ce21375960edcf162436ab86cd40b` |
| `apps/api/tests/test_agent_component_fixtures.py` | `e7cd8f171a76cf34a74326e7820807456e4f9bf31423c814144cf6c814b81ca3` |
| `pnpm-lock.yaml` | `617e93f9c73fe37fd0c4d502e8effcec7333d97a4b089d999062db09f86f5bc0` |
| `apps/api/requirements.txt` | `c95e73f9c0cb0dd34e793991c5e2aa8e685412f9466c6fb47f5d658a03a182f6` |

## 评测范围

共享 dataset 位于 `packages/contracts/fixtures/writer-tool-baseline.json`，由 Zod schema 校验。Python `BaseAgent` 与 TypeScript `ToolLoopRunner` 分别读取同一份 scripted model response：

- 最终文本与一次 search 后完成；
- 未知工具、handler error、非法 input 后恢复；
- 工具轮次用尽后的 finalization；
- `tool_use` 无 call 与空最终文本。

TS-only component tests 另外覆盖 tool result 顺序/`isError`、跨重写预算、总预算和单工具预算、重复/空 call id、矛盾 stop reason、`max_tokens`/`refusal`/`pause_turn`、空白正文、取消判定、metadata-only observer、adapter mutation 隔离、strict schema、Writer prompt/token budget、diagram 和 Research provenance。

## Compatibility 与 Target

| Case | Python compatibility | TypeScript target | 分类 |
|---|---|---|---|
| terminal/search final | 返回正文 | completed | 等价 |
| unknown tool | 英文 legacy 字符串后恢复 | `unknown_tool` 后恢复 | 可观测等价 |
| handler error | 原始异常消息后恢复 | 安全 `handler_error` 后恢复 | security delta |
| invalid input | handler error 后恢复 | schema `invalid_input` 后恢复 | validation delta |
| 两个工具轮次 + final | 两次请求后空字符串 | 第三次 finalization 得到正文 | intentional completion delta |
| `tool_use` 无 call | 继续并得到后续正文 | `invalid_model_response` | protocol safety delta |
| empty final | 空字符串 | `empty_final_text` | observability delta |

## 确定性结果

- 共享 case：8/8 Python compatibility 通过，8/8 TS target 通过；
- dataset schema 强制每个 case 标记 `equivalent | observable_equivalent | intentional_delta`；
- intentional delta：5 个；未分类 case：0；未分类 regression：0；
- 真实模型、真实 provider、LLM grader：未运行。

```text
contracts:     18 passed
model-runtime:  9 passed
agent-core:    92 passed
Python API:    49 passed
DB:             8 passed + typecheck + migration check
Web:           12 passed + lint + production build
Docs:          28 Markdown files, relative links valid
```

完整命令：

```bash
API_PYTHON=/absolute/path/to/.venv/bin/python pnpm verify
git diff --check
```

结果：全部通过。Python 3.14.5 pytest 仍产生 2486 条既有 asyncio/FastAPI/`utcnow()` deprecation warning，不影响本次 case 通过，但不属于 TS 等价证据。`git diff --check` 没有输出并以 0 退出。

专属测试在最终修正后单独重跑：`writer-tool-loop.test.ts` 35 项通过；Python `test_writer_tool_loop_compatibility_cases` 作为 1 个 pytest item 精确循环并断言 8 个共享 case。共享 dataset 的 5 个 intentional delta 由 schema 字段和 contracts 聚合断言固定。

### 可复现性边界

当前 worktree 未提交，因此 base revision 与 artifact hash 只能核对当前 checkout，不能从 Git 独立取回这份 patch。真正可独立重建的 code revision 必须是后续用户授权提交后的 commit SHA；在此之前不得把本记录描述为独立可恢复 artifact。Python 依赖含宽版本范围，完整环境重建还需要后续 lock/freeze 记录。

## 不代表什么

- 没有真实模型、搜索或 ToolModel adapter，不能证明供应商协议、timeout/retry 或成本；
- fixture 只检查确定性控制流，不证明正文质量、citation correctness、diagram correctness 或来源忠实度；
- `WriterService.write()` 一次返回完整章节，不是 token streaming；
- started/finished observer 未进入 durable event、trace 或线上 eval；
- TypeScript 组件没有接入 LangGraph.js、Worker 或生产流量。
