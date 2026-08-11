# Iteration 0036：Versioned Memory Policy Kernel

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0037](../decisions/0037-versioned-memory-policy-kernel.md)
- 评测记录：[Eval 0032](../evals/0032-memory-policy-kernel-baseline.md)

## 目标

在建立长期 Memory 表和 extractor 前，先固定 proposal contract、privacy gate、deterministic dedupe/conflict semantics 和 package boundary。

## 范围内

- `@vibe-writer/memory-core` workspace package；
- strict schema v1 与 versioned policy；
- typed subject、stable slot key、source/extractor/consent/expiry identity；
- content normalization 与 SHA-256；
- candidate、duplicate、conflict、expired、low-confidence、sensitive-inference 分类；
- 跨 slot comparison fail closed；
- persistence/model/vector neutrality architecture test；
- 根级 verify 接入。

## 范围外

- 不实现数据库、revision/evidence、review API、RLS 或硬删除；
- 不实现 extractor prompt/model、语义去重或冲突裁决；
- 不实现 embedding、retrieval、context assembly 或 Agent 注入；
- 不声称 Memory management、privacy classification 或 Memory Eval 已完整完成。

## 验证

- `pnpm test:memory-core`：2 个文件、7 项通过；
- `pnpm typecheck:memory-core`：通过；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 395 项、Python 50 项，共 445 项通过；component 38/38、workflow shadow 3/3、Web lint/test/build、全部 typecheck/migration check 和 117 个 Markdown 链接通过；
- `git diff --check`：通过。

## 退出条件

1. proposal identity 与 unknown-field rejection 可执行：满足。
2. sensitive model inference、low confidence 和 expiry fail closed：满足。
3. exact duplicate 与 changed-value conflict 分离：满足。
4. 跨 workspace/subject/slot 不能参与 dedupe：满足。
5. package 不依赖 persistence/graph/queue/model/vector vendor：满足。
6. 根级验证和文档闭环：满足。

## 后续

1. workspace-scoped candidate/memory/revision/evidence/tombstone schema；
2. owner/editor review、explicit replace 与 hard-delete cascade；
3. PostgreSQL RLS 和跨 workspace leak gate；
4. deterministic Memory write/revision Eval suite；
5. retrieval port、pgvector adapter 与 retrieval Eval。
