# Iteration 0002：迁移 fixture 与版本 manifest

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R1 契约与基线

## 目标

把当前 Python 实现的关键行为固化为可由未来 TypeScript 实现重复消费的 fixture，并让每次 Agent 运行可以指向明确的 prompt/model/tool/graph 版本。

## 范围内

- 建立去标识化的 API/SSE wire fixture；
- 使用 `@vibe-writer/contracts` 解析 fixture；
- 覆盖正常完成、人工确认、取消和错误终态；
- 建立当前 Python graph、prompt、model profile 和 tool schema manifest；
- 记录 fixture 来源、用途和更新规则；
- 为后续 Python/TS parity test 定义输入输出边界。

## 范围外

- 不调用真实付费模型生成新的 golden answer；
- 不迁移 Next.js 或 Worker；
- 不把非确定性的完整文章文本做 exact match；
- 不修复与 fixture 无关的既有 lint/API mock 问题。

## 实施内容

- 新增跨语言 `api-valid.json` 和 complete/cancelled/error SSE history；
- TypeScript 测试使用 Zod 解析所有 fixture，并检查 complete fixture 覆盖全部事件名；
- Python pytest 使用当前 Pydantic models 解析同一份 fixture；
- 新增 Python runtime manifest，记录 graph、model profile、tool 和关键源文件 SHA-256；
- manifest 测试在源文件变化但版本基线未更新时失败。

## 验证

```bash
pnpm test:contracts
pnpm typecheck:contracts
cd apps/api && ../../.venv/bin/python -m pytest tests/test_contract_fixtures.py -v
pnpm test:web
git diff --check
```

结果：

- `pnpm test:contracts`：通过，2 个测试文件、11 个测试；同时验证 JSON fixture、事件覆盖和 runtime artifact hash。
- `pnpm typecheck:contracts`：通过。
- `/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python -m pytest tests/test_contract_fixtures.py -v`：通过，2 个测试；出现 69 条 Python 3.14/pytest-asyncio 既有 deprecation warnings。
- `pnpm test:web`：通过，1 个测试文件、4 个测试。
- `pnpm build:web`：通过；保留既有 Mermaid/Vite 大 chunk warning。
- 重构文档相对链接检查：15 个 Markdown 文件全部可解析。
- `git diff --check`：通过。

当前 worktree 没有根级 `.venv`，所以 `pnpm test:api` 所使用的相对解释器路径不可用；本次使用原仓库已有虚拟环境执行同一 worktree 的聚焦测试，没有修改脚本或写入绝对路径。

## 验证中发现并修正

- 第一版覆盖测试只用成功 fixture 与全事件 inventory 比较，漏掉了 `cancelled/error` 两条互斥终态；现改为聚合 complete/cancelled/error 三类 history 后比较。
- 最初按仓库常用相对路径调用 `.venv` 失败；确认 worktree 环境后改用现有原仓库 venv，并在此保留环境差异。

## 退出条件

- TypeScript 与 Python 都能解析共享 fixture；
- 三类终态 fixture 合并后覆盖当前全部 SSE 事件；
- runtime manifest 与当前 Python graph/prompt/tool 源文件 hash 一致；
- contracts typecheck、现有 Web 测试/build 和 diff check 通过。

以上条件均已有当前验证证据，Iteration 0002 完成。

## 遗留风险

- fixture 冻结 wire shape，不代表模型输出质量；组件级 golden/eval 仍需在 R4 前建立。
- runtime manifest 使用源码 hash，能发现漂移，但不能判断漂移是否改善质量。
- 原仓库 venv 使用 Python 3.14，而 README 声明最低 Python 3.11；迁移期测试矩阵尚未统一。
