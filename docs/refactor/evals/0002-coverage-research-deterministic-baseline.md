# Eval 0002：Coverage/Research 确定性基线

- 日期：2026-08-07
- Dataset：`opinion-search-baseline-v1`
- Dataset schema：1
- As-of date：`2026-08-07`
- Python baseline：`python-c47cbfd0ab1f`
- TypeScript agent core：`agent-core-v1`
- Coverage prompt：`coverage-planner-v1-target-2026-08-07`
- Research prompt：`research-v1-target-2026-08-07`

## 运行 provenance

- Git base revision：`c47cbfd0ab1f05630f189c9aecfe0ab8ec50033f`
- Worktree：dirty，评测时共有 52 个 tracked/untracked 状态项；本轮没有 commit，不能只用 base revision 复现 TS patch
- Node.js：`v22.14.0`
- pnpm：`10.0.0`
- Python：`3.14.5`

相关 artifact SHA-256：

| Artifact | SHA-256 |
|---|---|
| `packages/agent-core/src/coverage.ts` | `caae8021ef315cd4b40cae363ead82c4a7a2f52fbc36c38ce46894d5a5429365` |
| `packages/agent-core/src/research.ts` | `c05bac55984c5947157167439b9b0f86928c320469fc245793b2f90c9d673a50` |
| `packages/agent-core/src/prompts.ts` | `7155f2e3d882b792eb81bd8a2289394127321b8079cfa0cd830aa167cf896760` |
| `packages/agent-core/src/versions.ts` | `585bd99413199c0c8b2d525b7a17a6ae55cf7ca6ea09f230c2dc23e364ac4849` |
| `packages/contracts/src/research.ts` | `a5ef1372f4eebfea1ac032092a56ac3afd8a513cdc76ed28785965c1fcf568ad` |
| `packages/contracts/src/research-component-fixtures.ts` | `78c5ba1c94df19425d09548fbdf5921260e0628b7d11f42a5b7155a2cee7295b` |
| `packages/contracts/fixtures/opinion-search-baseline.json` | `a227c2b01729b9fc57dc34564ae7781d4e03d05742fed673fc3ae5890697d08a` |
| `packages/agent-core/tests/research-components.test.ts` | `9647b87f147b916dc2186734f409493e6f00d16fb67fc28dae6782e8aad50182` |
| `packages/contracts/src/fixtures.test.ts` | `2186bd8b21fdb27f906ba333977e0f82045f6f9cec8dc3ec30cda626c06abbe5` |
| `apps/api/tests/test_agent_component_fixtures.py` | `a6ae98e1555367ef030d041a2041a67992858699905842473ad8f7fa6e5d76f2` |
| `packages/model-runtime/src/json.ts` | `80c9c259809e7c64cfb3997041d56fe92ef5cafceb91d881b048384d24a5bf1c` |
| `pnpm-lock.yaml` | `617e93f9c73fe37fd0c4d502e8effcec7333d97a4b089d999062db09f86f5bc0` |
| `apps/api/requirements.txt` | `c95e73f9c0cb0dd34e793991c5e2aa8e685412f9466c6fb47f5d658a03a182f6` |

## 评测范围

共享 dataset 位于 `packages/contracts/fixtures/opinion-search-baseline.json`，由 Zod schema 校验。Python 与 TypeScript 分别读取同一文件：

- Coverage：合法输出、非法 JSON、平行数组长度不等、非法成员和空列表；
- Query policy：普通技术、时效、明确历史年份及历史/当前对比查询的 topic、depth、limit 和日期上下界；
- Ranking：dated/undated 来源顺序和新鲜度；
- TS-only scripted orchestration：AbortSignal 对象转发与取消异常传播、来源字段保留与 prompt 注入、prompt date/version、no-result short circuit、选定 provider/model failure 映射。

共享 dataset 不包含 Python/TS Research success/empty/failure 端到端 parity；这些场景目前只在 TS scripted component test 中验证。因而本记录是 Coverage、query policy、ranking 的共享 baseline 加 TS Research boundary test，不是 Research 质量或完整跨语言等价评测。

## Compatibility 与 Target

| Case group | Python compatibility | TypeScript target | 分类 |
|---|---|---|---|
| 合法 Coverage | ready | ready | 等价 |
| 非法/空 Coverage | empty | inconclusive | intentional safety delta |
| 长度不等/非法成员 | 独立过滤后 ready | inconclusive | intentional safety delta |
| news 查询窗口 | `topic=news, days=90` | `topic=news, asOf-90d → asOf` | deterministic request-shape delta |
| general 查询窗口 | `days=365` | `general, asOf-365d → asOf` | deterministic request-shape delta |
| 明确历史年份 | news + 当前近 90 天 | general + 历史年份绝对范围 | historical retrieval safety delta |
| dated/undated news | undated 可能高于很旧 dated | 合法 dated 始终优先 | provenance delta |

## 结果

```text
contracts:     16 passed
model-runtime:  8 passed
agent-core:    54 passed
Python API:    48 passed
DB:             8 passed + typecheck + migration check
Web:           12 passed + lint + production build
Docs:          25 Markdown files, relative links valid
```

完整命令：

```bash
API_PYTHON=/absolute/path/to/.venv/bin/python pnpm verify
git diff --check
```

结果：全部通过。Python 3.14.5 pytest 仍产生 2395 条既有 asyncio/FastAPI/`utcnow()` deprecation warning，不影响本次 case 通过，但不属于 TS 等价证据。`git diff --check` 没有输出并以 0 退出。

专属测试在最终修正后单独重跑：`research-components.test.ts` 21 项通过；Python `test_agent_component_fixtures.py` 7 项通过。

### 可复现性边界

当前 worktree 未提交，因此 base revision 与 artifact hash 只能核对当前 checkout，不能从 Git 独立取回这份 patch。真正可独立重建的 code revision 必须是后续用户授权提交后的 commit SHA；在此之前不得把本记录描述为独立可恢复 artifact。Python 依赖含宽版本范围，完整环境重建还需要后续 lock/freeze 记录。

## 不代表什么

- 没有调用 Tavily 或真实模型，不能证明 provider adapter 与网络行为；
- 当前只证明 provider-independent request shape；不能把 `startDate/endDate` object 测试称为 Tavily adapter correctness；
- 没有真实文章/问题集和 grader，不能证明搜索相关性、来源权威性、摘要忠实度或文章质量；
- 没有 Writer/tool loop，不能证明工具轮数、引用渲染和 graph retry 行为；
- TypeScript 组件没有接入 Worker 或生产流量。
