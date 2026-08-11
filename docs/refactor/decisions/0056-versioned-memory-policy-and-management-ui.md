# ADR-0056：Versioned Memory Policy Registry 与 Role-aware Management UI

- 状态：Accepted
- 日期：2026-08-09

## 背景

Iteration 0053/0054已经提供默认关闭的signal和management API，但`MEMORY_CONSENT_POLICY_VERSION`只校验字符串格式，仓库没有该版本对应的可展示政策正文。客户端如果自行硬编码政策文本，服务端就无法证明用户确认的version与实际展示内容一致；如果客户端通过依次请求candidate/delete并观察403来猜角色，又会形成权限探测、请求瀑布和散落的UI授权逻辑。

已有signal列表还是无界读取。管理页一旦成为长期入口，无界返回会随着用户来源积累而放大数据库、RSC序列化和浏览器状态，违背Iteration 0054已经为active/candidate建立的有界读取原则。

## 决定

1. 在Web server边界维护append-only Memory consent policy registry。每个版本包含strict schema version、title、summary、statement、retention bounds与allowed signal kinds；环境变量只选择已注册版本。未知但格式合法的version同样视为配置无效，readiness、policy API、signal写入和管理页全部fail closed。
2. 新增共享`memory-policy` wire contract和`GET /api/durable/memory/policy`。响应返回当前注册政策、workspace role、服务端推导的capabilities与可提交subject选项；不返回membership、source或provenance内部记录。
3. capabilities只控制客户端展示，不替代授权。每个Route Handler仍重新解析trusted identity、查询membership，并由scoped repository与PostgreSQL RLS执行viewer/editor/owner边界；客户端篡改capability不能获得额外权限。
4. `GET /api/durable/memory/signals`升级为默认50、最大100的opaque UUID keyset page；repository始终在`workspace_id + created_by_principal_id`谓词内解释cursor，并增加`(workspace_id, created_by_principal_id, id)`索引。API不提供offset或无界limit。
5. `/memory`使用动态Server Component读取trusted request headers。首屏先完成feature、registry和membership检查，再用`Promise.all`并行读取active、own signals和角色允许的candidate；viewer不执行candidate query，signal feature关闭时不执行signal query。只把strict最小DTO序列化给Client Component。
6. Client Component负责policy确认表单、分页、candidate audit/review和显式删除交互。创建必须勾选当前policy version并生成`Idempotency-Key`；conflict materialize必须发送匹配slot的`replace_memory_id`；破坏性删除先要求确认。所有响应再次经过共享Zod schema解析。
7. 写作页只在durable与management flag同时启用时展示Memory入口，页面和API仍默认关闭。实现不注册provider、consumer、embedding或retrieval，也不把UI可用解释成production Memory质量已通过。

## 结果与限制

policy version第一次具备可审计的“版本 → 展示文本 → retention与允许动作”映射，服务端角色与UI能力也有单一投影。首屏没有客户端角色探测或串行collection waterfall，三类长期集合都有有界cursor与索引支撑。

当前registry随代码发布，不是可由管理员在线编辑的CMS；修改已存在版本内容属于违规，任何语义变化必须新增版本。当前UI只支持单条操作，不支持批量审核、搜索、筛选、revision history全文或删除恢复。真实auth/proxy、专用非owner API role、production canary和可用性研究仍未完成。

## 回滚

关闭`DURABLE_MEMORY_MANAGEMENT_API_ENABLED`会隐藏导航并让`/memory`进入fail-closed状态；关闭signal flag只移除来源创建/列表能力，不影响active治理。回滚代码不得删除已被历史signal引用的policy definition。已提交的signal、review与delete是durable业务事实，不随UI回滚撤销。
