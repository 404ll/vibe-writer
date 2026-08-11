# ADR-0055：Durable Memory Management Staging API

- 状态：Accepted
- 日期：2026-08-09

## 背景

ADR-0038已经规定active Memory可供workspace viewer读取、candidate正文与审核至少要求editor、整slot硬删除仅owner，但这些能力只存在于repository。Iteration 0053开放了user-authored signal入口；如果用户只能“让我记住”却不能查看当前Memory、审核模型提案或删除已物化内容，consent与erasure仍不是完整可操作闭环。

直接把数据库行序列化给HTTP会暴露content/evidence fingerprint、source UUID、review actor、current candidate外键和workspace内部字段。反过来只返回计数又无法让人工判断candidate是否准确、是否冲突以及要替换哪个active Memory。管理API必须提供完成决策所需的最小正文和版本信息，同时保留repository与RLS作为唯一授权语义。

## 决定

1. 新增独立`@vibe-writer/contracts/memory-management`严格契约，覆盖active Memory、candidate、candidate event、review和owner deletion receipt。所有mutation reason均为版本化machine-readable枚举，未知字段和任意reason fail closed。
2. API由`DURABLE_API_ENABLED`与独立`DURABLE_MEMORY_MANAGEMENT_API_ENABLED`双开关控制，不跟随signal API自动启用。它不要求当前consent policy配置，因为管理现有数据和创建新signal是不同能力。
3. `GET /api/durable/memory`复用`memory.listPage()`：workspace viewer可读取未过期active Memory的subject、slot、kind、当前revision正文和expiry。响应不暴露current candidate id或content fingerprint。
4. active与candidate collection必须使用opaque UUID keyset cursor，默认50、最大100；repository按primary key稳定前进并在workspace predicate/RLS内解释cursor。API不承诺时间排序，也不接受offset或无界limit，避免数据量增长后全表返回。
5. `GET /api/durable/memory/candidates`、candidate events和review复用editor gate。candidate DTO保留人工判断需要的content、confidence、source kind、consent、extractor/policy version、outcome和status；不暴露source run/signal UUID、evidence/content fingerprint或review actor principal id。
6. candidate event只返回有界业务轨迹`seq + event type + reason + time`。每个合法candidate至少有`proposed`事件，因此空结果按not found处理，不能用`200 []`混淆不可见资源。
7. materialize/reject继续由repository执行幂等审核、显式conflict replacement和revision CAS。exact replay返回同一结果；payload/actor/replacement漂移返回409；到期candidate在事务中清除并以410响应；跨workspace或不存在统一404。
8. `DELETE /api/durable/memory/:id`保持owner-only，硬删除active Memory、revision、slot candidates/events并返回content-free tombstone receipt。响应不包含slot fingerprint或已删除正文；同actor同reason可重放。
9. HTTP层继续复用trusted-proxy identity、membership、workspace-scoped repository和PostgreSQL RLS。Route Handler不自行复制角色判断，也不增加provider、queue、embedding或retrieval依赖。

## 结果与限制

系统形成source signal创建、active Memory查看、candidate人工治理、审计读取与owner erasure的默认关闭管理平面。管理API不是产品管理UI；它也不提供revision history全文、candidate搜索/筛选、批量审核或恢复删除。

active Memory的viewer可见性沿用ADR-0038的workspace语义，本轮没有把subject误当作新的数据库安全边界。若产品未来需要principal-private Memory，必须新增ADR、query predicate、RLS和跨角色迁移测试，不能只在UI隐藏。

真实auth provider、proxy header stripping、专用API DB role和托管HTTP canary仍未部署。API通过并不授权production Memory extraction consumer或说明真实模型质量合格。

## 回滚

设置`DURABLE_MEMORY_MANAGEMENT_API_ENABLED=false`即可停止管理HTTP流量，不影响signal retention、active Memory数据或后台maintenance。已完成的materialize/reject/delete是durable业务事实，不因关闭API回滚；错误审核必须通过新的candidate/revision流程纠正，硬删除不可恢复。
