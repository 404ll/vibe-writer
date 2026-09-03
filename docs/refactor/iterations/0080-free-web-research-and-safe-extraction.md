# Iteration 0080：自由联网研究与安全网页提取

> 状态：Done
> 日期：2026-09-03

## 目标

在保留 Writer 自主 Tool Calling 的前提下，把单一 Tavily snippet 搜索扩展为可配置搜索供应商和独立网页正文提取，并让真实搜索/提取进度可持久化、重放和展示。

## 根因核对

- 当前本地启动显式使用外部 `--env-file`；只检查键名与非空状态后确认 `TAVILY_API_KEY` 已进入加载路径，没有读取或输出凭据值。
- `run-durable-dev.mjs → process.loadEnvFile → child process.env → worker config → TavilySearchProvider → WriterService` 链路完整。
- 没出现搜索事件的原因是模型没有自主发起 `search` tool call，不是 key 缺失。原系统也没有 `extract_webpage`，因此搜索后只能消费 snippet。

## 范围内

- Tavily、Brave Search、SearXNG provider adapter 与显式/自动配置；
- provider-neutral `WebPageExtractor` / `WebExtractService`；
- 本地 Readability 提取、SSRF/private-network/redirect 防护、timeout、content-type、响应与正文上限；
- Writer 自主 `search → extract_webpage → write` 工具循环和外部不可信内容标记；
- fenced effect journal bounded metadata；
- `extracting/extract_done` PostgreSQL/SSE/Web 活动日志；
- Run tool snapshot、migration、配置文档和回归测试。

## 范围外

- 不改成每章强制搜索，不增加确定性 Research Node；
- 不实现浏览器自动化、JavaScript 执行、登录态、cookie、验证码或付费提取 SaaS；
- 不持久化网页正文、search query、snippet 或模型完整 transcript；
- 不修改 `.env`，不输出任何 provider credential；
- 不做真实付费搜索调用或搜索质量结论。

## 验证

- `pnpm verify`：通过。包含 contracts、model/provider runtime、Agent、Workflow、DB、checkpoint、Worker、Web、Eval 与 docs 的测试/typecheck/lint/build；其中本次直接相关结果为 provider 3 files / 28 tests、Agent 5 / 98、Workflow 2 / 53、DB 21 / 137、Worker 14 / 101、Web 24 / 79，`pnpm build:web` 通过。
- `pnpm check:migrations`：通过，Drizzle migration 一致。
- `pnpm eval:components`：38 cases / 38 trials，100% exact match。
- `git diff --check`：通过。
- 额外尝试 `pnpm test:worker:production:local`：5 项中角色边界 1 项通过；其余 4 项被既有 production fixture 阻断。fixture 仍把 `eventTypes` 限制为仅终态，但当前主链已持久化 `stage_update`、`generating_opinions` 等阶段事件，因此 exact-match/strict schema 失败；这些场景未触发本次新增的 search/extract 工具。未在本迭代顺手改写历史 production baseline。

## 剩余风险

- Readability 对依赖客户端渲染或反爬保护的站点会返回 empty/unavailable；
- 搜索供应商的实时账号、配额和 SearXNG engine 质量尚未通过收费/联网 smoke 证明；
- SearXNG 只提供 `day/month/year` 粗粒度时间窗且不同 engine 支持不同，本 adapter 不伪装成精确日期过滤；时效仍依赖返回日期与 Agent 交叉核验；
- 当前单跳 timeout 最多叠加到有限 redirect 次数，总耗时仍受重定向上限约束而非单一总 deadline。
- production composition 的旧 `eventTypes` fixture 与当前阶段事件投影不一致，需独立评测基线迭代处理；根级 `pnpm verify` 当前不包含该 local harness。
