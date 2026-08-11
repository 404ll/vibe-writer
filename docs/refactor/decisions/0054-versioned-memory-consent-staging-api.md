# ADR-0054：Versioned Memory Consent Staging API

- 状态：Accepted
- 日期：2026-08-09

## 背景

`memory_source_signals`已经支持显式用户来源、workspace权限、幂等、retention、删除传播和RLS，但没有HTTP入口。直接把repository字段逐一暴露给浏览器会让客户端自行声称`consentPolicyVersion`，也会把request/evidence fingerprint等内部实现泄露成公共契约。若缺少独立feature flag，durable API切流还可能顺带开放未完成的Memory产品。

API需要区分三件事：用户提交的明确同意、服务端当前接受的政策版本，以及后端是否实际启用模型提取。创建signal会原子写入pointer-only extraction outbox，但当前production Worker没有注册Memory dispatcher/consumer；API可用不表示模型处理已启用，更不表示真实模型质量已经通过校准。

## 决定

1. 在共享`@vibe-writer/contracts/memory-signals`中定义严格的create/list/delete wire schema。请求只接受版本化`explicit_user` consent、1–365天retention、固定source/subject/delete reason枚举和可选author-owned run；未知字段fail closed。
2. API由`DURABLE_API_ENABLED`与独立`DURABLE_MEMORY_SIGNAL_API_ENABLED`双开关控制。服务端还必须配置符合机器可读格式的`MEMORY_CONSENT_POLICY_VERSION`；任一条件缺失都返回503，且Memory feature开启但policy无效时durable readiness为503。
3. 客户端必须提交自己实际展示并确认的policy version，服务端与当前配置做精确比较。版本不一致返回409和当前版本，不能由客户端选择数据库最终保存的版本。
4. 创建请求必须携带1–256字符`Idempotency-Key`。同key同payload返回原signal与200；首次创建返回201；同key不同payload由repository fingerprint拒绝并返回409。API不为缺失key静默生成随机值。
5. HTTP层复用trusted-proxy principal/workspace解析、membership授权、workspace-scoped repository和PostgreSQL RLS。viewer可创建自己的principal signal；workspace/project subject仍要求editor；列表只返回当前principal自己的未过期signal；作者或workspace owner可删除。
6. wire DTO只包含用户需要查看的source kind、subject、text、consent、retention、创建时间和可选source run。workspace id、author id、idempotency key、request/evidence fingerprint和内部outbox状态不进入响应。
7. 删除采用固定reason code，执行硬删除和派生Memory/extraction fencing，只返回content-free tombstone receipt。重复同一删除返回可重放receipt；不存在的signal与不可见source run统一投影为404，避免跨workspace枚举。
8. 创建signal继续在同一数据库事务写入`memory.extraction.requested` outbox。公开API本身不注册dispatcher、consumer、provider或credentials；production Memory consumer必须由后续独立门禁显式启用。

## 结果与限制

产品现在有一个默认关闭、可独立canary的consent入口，且浏览器、Next.js和PostgreSQL共享同一版本化语义。它不是完整管理UI：当前只能列出自己的active source signal，尚不能查看derived candidate/active Memory、修改signal或观察extraction状态。

trusted-proxy仍只是部署seam，真实身份provider/header stripping与专用API DB role没有在本轮部署。consent policy文本、展示UI和版本发布流程也必须由产品发布单元管理；仅设置环境变量不能证明用户确实看到了对应文本。

## 回滚

将`DURABLE_MEMORY_SIGNAL_API_ENABLED=false`即可停止新建、列出和删除HTTP流量，不影响既有signal的retention maintenance。不得删除已创建signal或outbox作为回滚手段；用户删除和到期承诺继续由repository与maintenance进程执行。若policy发布错误，先关闭feature，再发布新policy文本/version并重新canary，不能原地复用旧version字符串。
