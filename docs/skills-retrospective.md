# Skills 使用复盘 — vibe-writer Phase 1

> 记录本次开发中用到的 Superpowers skills，供后续项目参考。

---

## 使用的 Skills

### 1. `superpowers:using-superpowers`

**触发时机：** 每次对话开始时自动触发。

**作用：**
- 建立 skill 查找和调用的规则
- 确保在执行任何任务前先检查是否有匹配的 skill
- 定义了 skill 优先级（process skills 先于 implementation skills）

**关键规则：**
- 即使只有 1% 的可能性 skill 适用，也必须调用
- 先调用 skill，再做任何其他事情（包括澄清问题）

---

### 2. `superpowers:subagent-driven-development`

**触发时机：** 执行多任务实现计划时。

**作用：** 通过派发独立 subagent 来执行计划中的每个任务，每个 task 有两阶段 review（spec compliance → code quality）。

**核心流程：**
```
读取计划 → 创建 TodoList → 循环每个 Task：
  派发 implementer subagent
  → spec compliance reviewer
  → code quality reviewer（如有问题则 implementer 修复 → re-review）
  → 标记 task 完成
→ 所有 task 完成后派发 final code reviewer
```

**为什么用 subagent 而不是直接实现：**
- 每个 subagent 有独立上下文，不会被其他 task 的细节污染
- 两阶段 review 能在早期捕获问题（spec 缺失 vs 代码质量问题分开处理）
- controller 负责协调，subagent 负责执行，职责清晰

**本次发现的问题示例（review 捕获）：**
- `store.py`: `event.clear()` race condition → code quality reviewer 捕获 → 修复
- `orchestrator.py`: job 不存在时继续调用 LLM → code quality reviewer 捕获 → 修复
- `App.tsx`: `setAwaitingReview` 在 `setJob` updater 内部调用 → code quality reviewer 捕获 → 修复
- `on_chapter` 介入逻辑缺失 → final code reviewer 捕获 → 修复

**模型选择策略（本次实践）：**
- implementer: `sonnet`（多文件协调任务）或 `haiku`（简单修复）
- spec reviewer: `sonnet`（需要仔细比对）或 `haiku`（简单确认）
- code quality reviewer: `haiku`（大多数情况够用）
- final reviewer: `sonnet`（需要全局视野）

---

### 3. `superpowers:test-driven-development`（subagent 内部使用）

**触发时机：** 每个 implementer subagent 在实现功能前先写测试。

**作用：** 确保先写失败的测试，再写实现，验证测试通过。

**本次实践：**
- 每个 task 都遵循了 red → green 流程
- Python 后端用 pytest，前端用 vitest
- 测试先于实现提交

---

## 工作流总结

```
brainstorming（设计阶段）
  ↓
writing-plans（写计划文档）
  ↓
subagent-driven-development（执行计划）
  每个 task 内部：
    implementer（TDD）→ spec review → code quality review
  ↓
finishing-a-development-branch（完成分支）
```

---

## 经验与建议

1. **计划文档质量决定执行质量**：计划写得越详细（包含具体代码、测试用例、验证命令），subagent 执行越准确，需要补充 context 的次数越少。

2. **两阶段 review 的价值**：spec review 和 code quality review 分开是有意义的——spec review 关注"做了该做的事"，code quality review 关注"做得好不好"。混在一起容易互相干扰。

3. **final reviewer 很重要**：本次 `on_chapter` 介入逻辑缺失是在 final review 阶段才发现的，单个 task 的 reviewer 视野有限，final reviewer 能从全局角度发现跨 task 的问题。

4. **模型成本优化**：简单的 spec 确认和质量检查用 haiku 就够，只有需要判断力的任务（multi-file 协调、final review）才用 sonnet。

5. **conftest.py 要早加**：Python 项目的 PYTHONPATH 问题在 Task 1 就应该加 conftest.py，而不是等到 Task 2 发现问题再加。
