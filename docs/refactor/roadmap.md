# TypeScript 全栈重构技术路线图

> 状态只由退出条件和验证证据推动，不按主观完成度填写。

> MVP状态：Done。Iteration 0063按用户决策退役Python兼容运行时，并把发布边界固定为Vercel Preview Web/API + 外部TypeScript Worker。Memory已移出当前产品范围；公开Production、正式多用户Auth与进阶Eval仍属后续工作。

## 阶段总览

| 阶段 | 状态 | 目标 | 退出条件 |
|---|---|---|---|
| R0 设计基线 | Done | 建立系统设计、ADR、路线图和迭代日志 | 文档互相链接；当前/目标/历史边界清楚 |
| R1 契约与基线 | Done | 共享 Zod 契约，冻结迁移行为样本 | Web 消费共享契约；契约测试通过；核心 fixture 入库 |
| R2 Next.js Web | Done | 将现有工作台迁到 App Router | 主页、文章页、编辑、Mermaid、SSE 行为测试与 build 通过 |
| R3 Durable data | Done | PostgreSQL、Drizzle、job/event/outbox | migration、repository、幂等和重放集成测试通过 |
| R4 TS Agent core | Done | 迁 Planner/Coverage/Research/Writer/Reviewer/LangGraph.js | 组件 eval 与当前基线对比可接受 |
| R5 Worker cutover | Done | BullMQ Worker、interrupt、取消、恢复、SSE | 唯一TS主链路已验证；Preview部署待外部资源 |
| R6 Memory | Deferred / archived foundation | candidate、长期 memory、retrieval、治理 | 不属于当前产品MVP；只有具体用户需求出现后重启 |
| R7 Eval/observability | MVP Done / Advanced deferred | 离线 experiment、线上抽样、回归门禁 | 本地与受控staging闭环已验证；托管观测延期 |
| R8 Python retirement | Done | 删除 FastAPI/Python、rewrite、shadow runner与SQLite import | TypeScript回归与production composition通过 |

R7 的最小骨架会在 R1/R4 提前建设，避免 Agent 迁完后才补评测。这里的 R7 指可供持续使用的完整产品化闭环。

R4 已完成 Planner/Reviewer、Coverage/Research/Search port、Writer/tool loop 与 LangGraph.js workflow runtime，并用 component fixture、checkpoint replay 和独立读者复核固定边界。下一阶段是 R5：PostgresSaver、Worker、durable resume/cancel/SSE projection 与真实 adapter 集成。

R5 已完成 job/run claim/lease/fencing、真实 PostgreSQL、PostgresSaver、BullMQ/outbox、durable workflow/terminal/reply/article staging API，以及真实 adapter、fenced effects、联合 composition 和 readiness。Iteration 0020 又提供 SQLite article/version 的 dry-run/apply/replay 迁移协议；实际部署 source 尚未执行。Iteration 0021 启动 R7：建立自有离线 runner、suite/case/run/trial/score schema 和 bounded provider trace；Iteration 0022 又把 38-case 确定性组件 suite、tracked baseline、只读 compare gate 和显式 PostgreSQL registration 纳入根级 `pnpm verify`。Iteration 0023 让 3 个 synthetic workflow 场景实际经过 Python/TypeScript LangGraph；Iteration 0024–0029 把 completed、outline resume、running cancellation、provider failure 和 expired-lease takeover 投影到真实 PostgreSQL、Redis/BullMQ、Worker、effect/trace/article 与 Next SSR；Iteration 0025 同时把 principal/workspace/membership、scoped repository、trusted-proxy seam 和 PostgreSQL RLS 变成真实隔离边界。Iteration 0030 再建立 PostgreSQL-owned queued Eval request、独立 BullMQ dispatcher/consumer、lease/fencing 和原子 report commit；Iteration 0031 建立不读取正文的 live candidate pointer、consent/retention、workspace review/event 与 RLS；Iteration 0032 完成 versioned workspace policy、durable/fair cursor、并发 scanner 和独立进程；Iteration 0033 完成 approved batch 到 retention-bound draft dataset 的 materialization、activation/fingerprint gate 和结果树 RLS；Iteration 0034 加入固定 rubric、provider-neutral model grader、Anthropic composition、multi-trial hard cost budget 和结构化 score metering。Iteration 0056又用真实Next与PostgreSQL固定专用Durable API role、有效权限verifier和header-stripping协议canary；Iteration 0057再为Memory retention建立独立跨workspace service role与启动时verifier。R7 接下来缺付费真实 judge calibration 与 CI artifact retention。公开切流当前主要硬门槛是目标环境真实auth/Ingress、API role实际部署、direct-to-Next封锁、实际 source dry-run 和 live/shadow eval，不能先改浏览器默认 API。

Iteration 0058进一步把write dispatcher和consumer拆成两个non-owner数据库身份，即使`role=all`也不共享连接；LangGraph checkpoint setup由显式admin命令承担，consumer启动不再执行DDL。真实PostgreSQL/Redis canary已在最小权限连接上重跑五类production projection和职责外访问负例。Iteration 0059再拆分Eval dispatcher、consumer与live sampler；sampler的content-free承诺由Article/Job/Run列级ACL保护。Iteration 0060按用户要求冻结MVP：上述能力足以进入产品验证，不再自动拆分synthetic publisher、migration与运维角色。production部署项保留为backlog，仅在明确上线阻塞时恢复。

Iteration 0036 启动 R6：先建立 provider/persistence-neutral Memory policy kernel，固定 strict proposal、workspace 内 typed slot、content fingerprint、sensitive inference/low-confidence/expiry rejection，以及 duplicate/conflict 分离。Iteration 0037 已把 policy 接入 candidate/active memory/revision/event/tombstone 数据模型，完成 editor review、explicit conflict replace、owner hard delete、retention/source deletion propagation 和真实 PostgreSQL RLS。Iteration 0038 又把 proposal 与 review/revision transition 纳入 tracked deterministic Eval gate；Iteration 0039 把 model output 与 workspace/source/consent/retention trusted envelope 分离并限制为20-item unique-slot batch；Iteration 0040用scripted extractor打通terminal outbox、独立Memory BullMQ和幂等candidate submission；Iteration 0041再建立独立task/attempt/effect ledger、DB lease/heartbeat、content-free usage/cost metering，并对unknown provider outcome和post-provider failure fail closed。Iteration 0042建立`author/scope/text` trusted segment、versioned strict prompt/TextModel adapter和24-case should-write/slot/leak gate，同时证明当前task topic与assistant article都不是合法durable source。Iteration 0043新增显式user-authored signal/tombstone、subject权限、幂等、retention、erasure与真实RLS；Iteration 0044把proposal/candidate升级为`run | signal` typed source，可信重验signal，并用数据库外键完成candidate/event/active Memory/revision删除传播，governance v2 gate为20 cases；Iteration 0045进一步把task/attempt/effect、transactional outbox和BullMQ迁到typed source，并在signal删除时以`cancelled | uncertain`保留content-free effect审计；Iteration 0046用versioned pricing和PostgreSQL workspace锁建立source/UTC日hard cost reservation；Iteration 0047再以owner-only evidence和append-only RLS audit建立`uncertain` resolution与有界requeue；Iteration 0048把request lookup抽象为strict provider port，以snapshot pricing结算，并保证pending、not-found和transport failure不改写ledger；Iteration 0049纠正HTTP request与provider response object双identity，并以tracked 24-case/72-call manifest建立不联网、不读credentials的calibration No-Go gate；Iteration 0050继续固定execution manifest、exact cost quote、immutable approval binding、72-trial provider-neutral runner与unmetered/identity fault熔断；Iteration 0051再把binding/base execution、owner approval和append-only audit持久化到PostgreSQL，并在同一事务接入既有Eval run/outbox和独立Worker registry；Iteration 0052把保留期落实为独立DB-only进程，以数据库时间、全局due index、有界`SKIP LOCKED`批次和content-free backlog report主动收敛，并用真实PostgreSQL双会话证明并发实例不会互相阻塞；Iteration 0053用共享契约、独立feature flag、服务端policy version、必填幂等键和现有membership/RLS建立默认关闭的signal consent staging API。Iteration 0056与0057已分别建立公开Durable API和Memory retention的专用精确权限角色。当前下一硬依赖是由operator明确model、官方pricing snapshot与最高费用，审批后运行真实calibration并完成人工quality/usage/账单核对；Anthropic同步Messages没有文档化request-level terminal lookup，所以unknown outcome仍保持hold。其后才是shadow production consumer、retrieval port/pgvector 和真实 should-write/retrieval/answer-uplift Eval。

Iteration 0054进一步把active current revision、candidate/event、review和owner hard delete接入独立feature flag下的management staging API。HTTP只投影人工治理需要的正文与版本，隐藏source UUID、evidence/content fingerprint、review actor和slot tombstone fingerprint，并保持viewer/editor/owner矩阵；collection使用默认50、最大100的opaque keyset cursor。R6下一产品层依赖是versioned policy展示与role-aware管理UI；生产依赖仍是真实calibration、目标环境角色部署和shadow consumer，不能因为management API可调用就提前启用模型或retrieval。

Iteration 0055把policy version从格式字符串提升为append-only registry中的精确文档，未知version让readiness、signal写入和管理页fail closed。服务端统一投影viewer/editor/owner capability，`/memory`在RSC中并行读取有界active、own signal与授权candidate，Client Component只负责显式consent、audit/review和删除交互。own signal也升级为UUID cursor并增加`workspace + author + id`索引。R6下一工程门槛是真实auth/proxy与非owner API role canary；模型路径仍需先完成受控calibration，之后才允许shadow consumer和retrieval Eval。

Iteration 0056将整个Durable HTTP面的table/sequence权限固化为精确role contract，要求当前连接无owner/superuser/BYPASSRLS、role membership、对象ownership、schema CREATE或清单外DML。一次性PostgreSQL + production Next + loopback proxy canary证明header清洗协议、401/403、viewer/editor/owner、跨workspace RLS、candidate review、owner erasure与signal撤回；同时把legacy API rewrite改为fallback，避免动态Durable路由被FastAPI抢占。R6下一步仍是付费真实calibration和目标环境auth/Ingress部署证据；本地proxy fixture不能替代production身份系统。

Iteration 0057把Memory retention从通用owner连接迁到专用`DATABASE_MEMORY_RETENTION_URL`。共享role engine验证有效权限全集，但retention保留独立manifest；跨workspace扫描显式使用`BYPASSRLS`，同时没有sequence、Job、Article、Eval、DDL或ownership能力。实例在ready前自校验，真实PostgreSQL canary跨两个workspace清理source、running effect、active Memory和candidate，并验证`jobs`读取被拒绝。下一数据库边界是write Worker/dispatcher、Eval与migration角色拆分。

Iteration 0058已完成write Worker内部的dispatcher/consumer身份拆分与checkpoint DDL分离。consumer只拥有当前durable execution和checkpoint DML，dispatcher只拥有outbox领取/结算能力；配置、current-role verifier和真实production projection共同阻止owner fallback或身份误配。

Iteration 0059已完成Eval dispatcher/consumer/live sampler身份拆分。consumer保留跨workspace governed suite所需的显式`BYPASSRLS`，但无outbox、Job/Article或DDL权限；sampler只获得policy/candidate DML与Job/Run/Article安全列读取。`pnpm test:eval-queue:local`使用真实PostgreSQL+Redis完成38-case queued run，`pnpm test:db:postgres:local`证明sampler能扫描但不能读取正文。下一数据库边界是migration、人工Eval CLI与运维查询角色。

Iteration 0060执行MVP完成审计并停止基础设施扩建。当前进入用户验证阶段；下一迭代不预设技术主题，只有真实用户反馈、明确production切流需求或版本化Eval退化才触发。真实Auth/Ingress、云资源、付费calibration、RAG与剩余角色拆分不属于当前MVP。

Iteration 0061根据首轮用户反馈补齐“能实际切过去使用”的本地产品composition。`pnpm dev:durable`现在会准备持久化PostgreSQL/Redis、migration/checkpoint和最小权限角色，再把Next浏览器/API/文章读取与TypeScript Worker统一切到durable路径；无付费模型的完整HTTP smoke已覆盖outline确认、SSE终态和article revision编辑/restore。公开生产No-Go保持不变，本地固定身份不能替代真实Auth/Ingress，历史SQLite也不会自动导入。

Iteration 0062按用户决策把Memory从当前产品MVP延后。既有R6实现改为归档基础：`dev:durable`不展示入口、不启用API/consumer，写作终态默认不投递Memory extraction，核心readiness也不再依赖Memory schema。未来不能仅打开feature flag恢复，必须由具体场景重新定义source、consent、context injection和质量/成本Eval。

Iteration 0080在不改变R4自主Tool Calling决策的前提下扩展Research能力：搜索provider可在Tavily、Brave Search、SearXNG之间显式选择，Writer可在搜索后自主选择公开URL并通过本地Readability提取正文。提取边界拒绝私网/特殊地址并限制重定向、时长、响应大小、正文长度和content-type；搜索/提取失败作为结构化工具结果回到Agent，不伪造来源，也不强制每章联网。

## R1：契约与行为基线

### Iteration 0001：共享 contracts

- 建立 `packages/contracts`；
- 将 job、article、SSE 事件定义为 Zod schema 和推导类型；
- 现有 Web 从共享 package 消费 SSE/type 契约；
- 保持 FastAPI 响应和 UI 行为不变。

### Iteration 0002：迁移 fixture 与契约校验

- 从当前 Python 测试和典型运行提取 API/SSE fixture；
- 验证 Python 输出可被 Zod 契约解析；
- 固定 outline、tool loop、review fallback 和 export 的关键行为样本；
- 建立 prompt/model/tool version manifest。

## R2：Next.js Web

- 在 `apps/web` 内迁移，不长期维护两套 Web 产品；
- Server Component 负责文章读取，编辑器、Mermaid、任务 UI 和 SSE 为 Client Component；
- 重型 Mermaid 动态加载，避免进入初始共享 bundle；
- localStorage 只保存版本化、最小化的恢复指针；
- API 请求和 SSE 解析保持集中，不散落到页面组件。

## R3–R5：后端切换顺序

1. Drizzle schema/repository 和迁移；
2. job/event/outbox 与 queue adapter；
3. model runtime、usage 和 trace；
4. Agent 组件逐个迁移；
5. LangGraph.js 组图和 PostgresSaver；
6. Worker heartbeat/reconciler/abort；
7. Next API/SSE 切到 durable store；
8. shadow/fixture 对比后切除 Python 路径。

## 每个迭代的统一门槛

- 有明确范围和范围外；
- 行为变化有契约或测试；
- 数据模型变化有 migration 和回滚说明；
- 架构变化有 ADR；
- 至少运行最相关的 test/typecheck/build；
- `git diff --check` 通过；
- 迭代记录包含真实命令结果和剩余风险。
