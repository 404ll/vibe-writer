# @vibe-writer/workflow-runtime

LangGraph.js workflow adapter。负责可序列化 state、interrupt/resume、节点组装和控制流；不拥有 HTTP、数据库、队列、模型供应商或 trace adapter。

领域组件和纯 policy 继续位于 `@vibe-writer/agent-core`。当前 Iteration 0008 只使用 scripted services 与内存 checkpointer，尚未接入 Worker 或生产流量。

MemorySaver 测试证明同一进程内、同一 saver/thread 的 interrupt resume、章节 checkpoint replay 和 terminal replay；不证明进程重启或 PostgresSaver。默认 `executionConfig` 为 `prototype-unbound`，只能用于 component test，生产 Worker 必须绑定真实 graph/prompt/model/tool/code 版本。

应用 state 是 Zod JSON payload，不等于完整 LangGraph checkpoint envelope。生产接入前还需要 serializer/version、隐私/容量/TTL、旧 graph migration、tool-call crash journal 和 bounded run-record projection。
