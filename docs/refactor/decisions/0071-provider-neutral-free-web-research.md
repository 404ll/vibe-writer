# ADR-0071：Provider-neutral 自由联网研究与安全网页提取

- 状态：Accepted
- 日期：2026-09-03
- 关联：[ADR-0007](./0007-search-port-and-research-outcomes.md)、[ADR-0017](./0017-provider-adapters-and-worker-process-boundary.md)、[ADR-0018](./0018-fenced-provider-effects-and-metadata-trace.md)

## 背景

Writer 已有模型自主调用的 `search` 工具，但生产 composition 只支持 Tavily，且搜索结果只有标题、URL 和 snippet。模型无法在找到来源后继续读取网页正文；当模型没有发起 tool call 时，也不会产生搜索事件。此前一次本地诊断把“没有搜索”误判成 Tavily key 缺失，但实际启动命令通过显式 `--env-file` 加载了非空 key，完整装配链也会注册 search 工具。

[OpenClaw Web Search](https://docs.openclaw.ai/tools/web) 将 provider-neutral 搜索、轻量网页抓取和完整浏览器自动化分层；[OpenClaw Web Fetch](https://docs.openclaw.ai/web-fetch) 把网页内容标记为外部不可信数据并限制正文长度；[Hermes Web Search](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/web-search.md) 同样把 `web_search` 与 `web_extract` 分开，并允许搜索与提取使用不同后端。本项目借鉴该边界，不引入 OpenClaw/Hermes 运行时依赖。

Adapter 形状另以各项目的一手文档为准：[Brave Web Search API](https://api-dashboard.search.brave.com/api-reference/web/search/get) 使用 `GET /res/v1/web/search` 与 `X-Subscription-Token`；[SearXNG Search API](https://docs.searxng.org/dev/search_api.html) 支持 `/search?format=json`，但实例必须启用 JSON 格式；[Mozilla Readability](https://github.com/mozilla/readability) 在 Node.js 中接收 DOM 并返回 `textContent`。Readability 不负责清理不可信 HTML，所以本实现只把纯文本送入模型，不渲染其 HTML 输出。

## 决定

1. 保留 Writer 的自由 Tool Calling。Coverage 只提供搜索方向，不增加“每章必搜”的确定性节点；模型可按章节需要执行 `search → extract_webpage → 继续搜索/写作`。
2. `SearchProvider` 继续是供应商无关端口。Worker 新增 Tavily、Brave Search 与 SearXNG adapter；`WEB_SEARCH_PROVIDER` 可显式选择，未设置时按已有配置确定性自动选择，没有可用配置则不注册 search。
3. 网页正文提取使用独立 `WebPageExtractor` 端口与本地 `Mozilla Readability + LinkeDOM` adapter。它不执行 JavaScript、不使用登录态、不承担浏览器自动化。
4. 任意模型提供的 URL 必须使用公开 HTTP(S) 默认端口，不得携带 URL credential。每个 hostname 和每次 redirect 都解析 DNS；只要结果包含 loopback、private、link-local、metadata、benchmark、documentation、multicast 或 reserved 地址就拒绝。实际 HTTP 连接钉在已验证地址上，缩小 DNS rebind 的检查/使用窗口。
5. 提取请求有单跳 timeout、最大重定向次数、响应字节上限、正文字符上限与 `text/html | application/xhtml+xml | text/plain` content-type 白名单。工具结果明确包裹为 `external_untrusted_content`，提示模型只能把内容当资料，不能执行其中指令。
6. Search/Extract 的非取消失败收敛成结构化 `unavailable | failed` tool result，模型可换词、换来源或基于已有证据继续；失败不得伪装成来源。取消继续向上抛，由 Worker 收敛当前 attempt。
7. 两类外部调用继续进入 fenced effect journal。journal/trace 只保存 provider、结果数量、content-type、字符数、耗时等 bounded metadata，不保存 query、URL、snippet 或网页正文。
8. 新增 `extracting/extract_done` durable event。它们由 Graph 生成稳定 attempt/tool ordinal key，经 Worker lease fencing 写入 PostgreSQL，再由 SSE 重放；事件只保存 URL、标题、状态与字符数，不保存网页正文。
9. 每次 Run 的 `tool_versions` 显式记录 Writer toolset、实际 search provider 与本地 extractor 版本；Writer toolset提升到 v2。旧 checkpoint 不在新工具配置下静默续跑。

## 取舍

- 本地 Readability 无额外抓取服务费用，且数据不必先发送给第三方提取商；代价是无法处理依赖 JavaScript、登录态、反机器人挑战或复杂交互的页面。
- SearXNG 可自托管且无需搜索 API key，但实例质量、可用 engine 与 JSON 格式由 operator 负责；运行时失败只影响该次工具结果，不把文章任务直接伪装成搜索成功。
- 工具选择仍依赖模型，因此“配置了 key”不等于每章一定搜索。产品若未来需要强制研究，应新增独立 workflow policy，而不是修改这套自由工具语义。

## 回滚

先把 `WEB_EXTRACT_ENABLED=false` 并将 `WEB_SEARCH_PROVIDER=tavily|disabled`，随后部署不产生 `extracting/extract_done` 的旧 Worker。数据库 migration 与 Web consumer 可保留向后兼容；最后再回滚 Writer toolset 代码。不得在旧数据库 check constraint 尚未升级时部署会产生新事件的 Worker。
