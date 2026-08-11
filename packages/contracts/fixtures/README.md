# Migration fixtures

component baseline fixture 同时保存 Python compatibility 与 TypeScript target behavior。两种行为不必永远相同：已知安全修正必须显式记录差异，不能把旧缺陷复制成所谓迁移等价。

这些 JSON 文件记录 2026-08-07 Python/FastAPI 基线的稳定 wire shape，用于未来 TypeScript API/Worker parity test。它们不是模型生成质量的 golden answer，也不能代替真实端到端 eval。

## 文件

- `api-valid.json`：当前 Web 使用的 job/article 请求和响应样本。
- `sse-complete.json`：一次包含全部事件种类的成功任务历史。
- `sse-cancelled.json`：取消终态。
- `sse-error.json`：错误终态。
- `agent-component-baseline.json`：Planner/Reviewer 解析、预算与无效输出基线。
- `opinion-search-baseline.json`：Coverage、查询策略与来源排序基线。
- `writer-tool-baseline.json`：Writer tool loop 的协议、错误和轮次基线。
- `workflow-control-baseline.json`：全文 rewrite route 与 Writer inconclusive policy 基线。
- `workflow-shadow-baseline.json`：迁移期形成、现在由 TypeScript production projection 复用的无网络 workflow 场景与产品级期望投影。
- `production-composition-baseline.json`：把 workflow expected 继续约束到 PostgreSQL、BullMQ、Worker、terminal article/event/effect/trace 的 durable projection。

## 更新规则

1. 修改 API/SSE wire contract 时，代码、Zod schema、fixture 和两端测试必须在同一迭代更新。
2. 修改 `prompts.py`、`base.py`、`writer.py` 或 `graph.py` 时，必须判断是修复、行为变化还是纯重构；确认后更新 manifest hash 和对应 eval baseline。
3. fixture 必须去标识化，不得包含密钥、真实用户数据或付费模型原始敏感输出。
4. 非确定性正文不做 exact match；只冻结结构、事件顺序、终态、工具协议和可确定字段。
