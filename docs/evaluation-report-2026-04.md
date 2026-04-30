# vibe-writer 客观评测报告

**评测日期：** 2026-04-30  
**评测版本：** v3（LangGraph 重构 + 编辑态 + 历史版本）  
**评测方法：** 静态代码分析 + 测试套件审查 + 架构对照业界标准

---

## 一、评测框架说明

参照 Anthropic《Building Effective Agents》及业界通行的 Agent 评测维度，从以下 5 个维度打分（满分 10 分）：

| 维度 | 说明 |
|------|------|
| **任务规划能力** | Agent 能否合理分解任务、管理执行顺序 |
| **工具使用能力** | 工具设计是否合理，调用是否有效、可靠 |
| **自主性与反馈循环** | Agent 能否自主获取信息、根据反馈迭代 |
| **可靠性与容错** | 异常处理、边界条件、降级策略 |
| **工程质量** | 代码结构、测试覆盖、可维护性 |

---

## 二、逐维度评分

### 1. 任务规划能力 — 8/10

**做得好的：**
- PlannerAgent 专职生成大纲，职责单一清晰
- OpinionAgent 为每章生成 2-3 个核心论点 + 搜索方向，实现了"宏观方向（Opinion）+ 微观自主（Writer tool_use）"的分层规划
- LangGraph 图结构让控制流显式化（`plan → write → review → [rewrite?] → export`），比 v1 硬编码的 if/else 清晰得多
- `should_rewrite()` 作为唯一条件边，决策逻辑集中、可读

**不足：**
- 大纲生成后用户可以确认（human-in-the-loop），但 **介入节点功能在 v2 图中实际上未实现**——`jobs.py` 里虽有 `/reply` 端点，`wait_for_reply()` 接口也在 `JobStore`，但 `graph.py` 的 `plan_node` 没有挂起等待用户确认的逻辑（这是 v1 `Orchestrator` 里有、v2 迁移时丢失的功能）
- 章节数量完全由 LLM 决定（3-6 章），无结构验证；LLM 偶发生成非列表格式时 `_parse_outline` 会返回空列表，下游静默失败

**评级：良好**

---

### 2. 工具使用能力 — 8.5/10

**做得好的：**
- `WriterAgent` 有两个工具：`search`（按需获取资料）和 `generate_diagram`（自主决定是否配图），工具职责分明
- 工具描述写得有引导性（"当你需要具体数据、案例时调用"），能有效减少不必要的调用
- `search_fn` 通过依赖注入传入 Writer，而非 Writer 直接持有 SearchAgent——解耦做得好，换搜索实现不需动 Writer
- `max_tool_rounds=10` 防止无限循环，是合理的安全上限
- Tavily 搜索结果经 LLM 二次提炼再传给 Writer，而非直接塞入 prompt——信息密度更高

**不足：**
- `write_stream()` 的实现是假流式：内部调用 `_call_llm_with_tools()` 完整生成后才 `yield content`，导致 tool_use 阶段前端无任何 token 流，用户体验有明显停顿（README 也承认了这一点）
- `search_fn` 在 `write_stream` 中通过 `lambda query: self._search_fn(query)` 包装，多一层无意义的匿名函数，没有实际作用
- `generate_diagram` 的 `_handle_diagram` 把 Mermaid 代码包成 fenced block 返回给 LLM，依赖 LLM 将其"插入正文合适位置"——这是间接控制，实际插入位置不可预测

**评级：良好**

---

### 3. 自主性与反馈循环 — 7.5/10

**做得好的：**
- WriterAgent 真正实现了 ReAct loop：LLM 在写作中途可以主动调用 search，而不是被动接收预先搜集的资料，是从流水线 Agent 到自主 Agent 的真实跨越
- ReviewAgent 两轮机制（章节轻审 + 全文重审）形成了显式反馈循环，`review_feedback` 会作为修改意见传回 Writer
- LangGraph checkpointer 接入 SQLite，任务状态可持久化，断线后理论上可恢复（`rewrite_count` 等状态都在 `WriterState` 中）

**不足：**
- Review 的反馈质量完全依赖 LLM 生成 JSON 的稳定性。`review_chapter` 和 `review_full` 在 JSON 解析失败时都 fallback 为"全部通过"——这是正确的容错策略，但意味着**反馈循环可能在无声无息中短路**，不通过的章节被当作通过处理
- WriterAgent 的搜索次数上限写死在 prompt 里（"不超过 3 次"），而不是在代码层强制执行，实际约束力取决于 LLM 的遵从度
- 全文审稿把所有章节内容一次性塞入 prompt，章节多时有 token 溢出风险（README 已知问题）

**评级：中等偏上**

---

### 4. 可靠性与容错 — 7/10

**做得好的：**
- 搜索失败降级为空字符串，不中断写作流程
- `_call_llm_json` 解析失败 log warning + 返回空 dict，下游有明确 fallback
- Orchestrator v1 有写作重试机制（writer 前两次抛异常，第三次成功）
- BaseAgent 的 `_call_llm_with_tools` 有 `max_tool_rounds` 保护

**不足：**
- **graph.py 的 `export_node` 直接用同步 `open()` 写文件**，在 asyncio 事件循环中是阻塞调用，在高并发下会卡住整个 event loop
- graph 节点中出现异常时，`jobs.py` 的 `_run_agent` 只做了顶层 try/except 推送 error 事件，没有节点级的错误恢复（v1 Orchestrator 有章节级重试，v2 迁移后丢失）
- `WriterState` 里有 `error` 字段，但 `graph.py` 中没有任何节点向它写入，这个字段目前是死代码
- `JobStore` 纯内存，服务重启后任务元数据（topic/style）丢失，checkpointer 里的 WriterState 虽然持久化了，但 JobStore 无法重建，断点续写实际上跑不通

**评级：中等**

---

### 5. 工程质量 — 7.5/10

**做得好的：**
- 模块划分清晰：BaseAgent → 各专职 Agent → graph 节点 → router，层次分明
- 所有 prompt 集中在 `prompts.py`，易于修改和版本管理
- 测试套件覆盖主要 Agent 行为，使用 mock 而非真实 API 调用，运行速度快
- `conftest.py` 使用 SQLite 内存数据库隔离测试环境
- README 和代码注释质量较高，有架构演进记录

**不足：**
- **测试与代码的同步问题是目前最严重的工程问题**：
  - `test_orchestrator.py` 全部 10 个测试因 `from backend.agent.orchestrator import Orchestrator` 无法 import 而**全部失效**（v2 重构删除了 `orchestrator.py` 但测试未同步删除或迁移）
  - `test_store.py` 3 个测试因 `create_job()` 接口变化（新增必填参数 `job_id`）而失败
  - `test_writer.py` 4 个测试因 `write()` 移除了 `research` 参数而失败
  - **总计：40 个测试中 14 个失败**（含 test_orchestrator.py 的 10 个），失效率 35%
- `SearchAgent` 里 `get_event_loop()` 是 Python 3.10+ 已弃用的调用方式，在某些环境会有 DeprecationWarning
- frontend 测试套件（React/Vitest）未在评测范围内，但 `test-setup.ts` 的存在表明有前端测试框架，实际测试文件数量不明

**评级：中等偏上**

---

## 三、综合评分

| 维度 | 得分 | 权重 |
|------|------|------|
| 任务规划能力 | 8.0 | 20% |
| 工具使用能力 | 8.5 | 25% |
| 自主性与反馈循环 | 7.5 | 25% |
| 可靠性与容错 | 7.0 | 15% |
| 工程质量 | 7.5 | 15% |
| **综合得分** | **7.8 / 10** | |

---

## 四、横向对比：和业界 Agent 设计原则的差距

对照 Anthropic 官方《Building Effective Agents》的三条核心原则：

| 原则 | vibe-writer 的实现 | 差距 |
|------|-------------------|------|
| **Simplicity** 保持简洁 | 整体做到了——每个 Agent 职责单一，没有过度抽象 | 轻微：LangGraph 引入了一些框架复杂度，在项目规模下属于合理取舍 |
| **Transparency** 透明化规划步骤 | SSE 实时推送每个阶段事件，前端可视化做得好 | 中等：`should_rewrite()` 决策对用户不可见；review feedback 展示在前端但决策逻辑不透明 |
| **ACI** 精心设计工具接口 | search 和 generate_diagram 的描述写得较好 | 中等：`generate_diagram` 的"将返回的代码块插入正文合适位置"是模糊指令，执行结果不稳定 |

---

## 五、优先修复建议

按影响程度排序：

### 高优先级（影响可靠性）

1. **修复 14 个失效测试**  
   - 迁移或删除 `test_orchestrator.py`（v2 已无 Orchestrator）  
   - 修复 `test_store.py`（调用方式改为 `store.create_job(job_id=..., topic=...)`）  
   - 修复 `test_writer.py`（移除 `research` 参数）

2. **export_node 的同步文件写入改为异步**  
   ```python
   import aiofiles
   async with aiofiles.open(output_path, "w", encoding="utf-8") as f:
       await f.write(markdown)
   ```

3. **补全 human-in-the-loop**  
   `plan_node` 在推送 `outline_ready` 后加上 `await job_store.wait_for_reply(job_id)`，恢复 v1 有、v2 丢失的大纲确认功能

### 中优先级（影响体验）

4. **JobStore 与 checkpointer 双持久化对齐**  
   服务启动时从 SQLite checkpointer 重建 JobStore 元数据，让断点续写真正跑通

5. **Review fallback 要可观测**  
   JSON 解析失败时不只是 log warning，也推送一个 SSE 事件让前端提示用户"审稿结果不可靠"

### 低优先级（完善）

6. **WriterAgent 搜索次数在代码层限制**  
   在 `_call_llm_with_tools` 调用时传入 `max_tool_rounds=4`（3 次搜索 + 1 次生成），而不是依赖 prompt 约束

7. **替换弃用的 `get_event_loop()`**  
   `search.py` 改用 `asyncio.get_running_loop()`

---

## 六、总结

vibe-writer 是一个**架构思路清晰、局部细节待打磨**的学习型 Agent 项目。

**最大亮点：** WriterAgent 的 ReAct loop 设计（自主搜索）和 LangGraph 重构（控制流显式化）是真正有设计感的决策，体现了对 Agent 模式的理解。

**最大短板：** 测试套件跟不上重构节奏，35% 的测试失效意味着代码信心度打折——下次重构时没有测试保护网。这是比任何功能缺陷都更需要优先处理的问题。

**整体判断：** 作为一个从流水线 Agent 迭代到自主 Agent 的练手项目，完成度和工程规范性都达到了中等偏上水平，在架构理解深度上已经超过了大多数"跑通一个 demo"级别的 Agent 项目。

---

*报告由 Claude Code 自动生成，基于静态代码分析，未运行真实 LLM 调用测试*
