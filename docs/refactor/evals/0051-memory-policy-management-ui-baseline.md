# Eval 0051：Memory Policy 与 Management UI 工程基线

- 日期：2026-08-09
- 结论：Passed；contract、registry、role projection、Server-first loader、UI交互与真实PostgreSQL分页/RLS回归均通过
- 对应迭代：[0055](../iterations/0055-versioned-memory-policy-and-management-ui.md)

## 行为矩阵

| 条件 | 预期结果 |
|---|---|
| durable/management关闭 | 导航隐藏，`/memory`显示fail-closed状态，repository不执行 |
| policy version格式合法但未注册 | readiness/policy/signal/page均503或configuration-invalid，数据库不写入 |
| viewer | 读取active、管理own signals；不查询/显示candidate，不显示active删除 |
| editor | viewer能力 + shared signal subject + candidate audit/review；无active删除 |
| owner | editor能力 + active hard delete |
| 首屏三组collection | 服务端并行开始；disabled collection不查询；每组最多50 |
| own signals超过一页 | opaque UUID cursor继续，最大100，不重复且不跨author/workspace |
| conflict candidate确认 | 必须携带同slot当前Memory id，否则不提交 |
| 来源或active删除 | 用户先确认；成功后本地移除；服务端仍重新授权 |
| mutation成功但active刷新失败 | 保留成功事实并提示重新打开，不误报mutation失败 |

## 数据与渲染边界

- registry在server-only模块中按version解析，每次返回strict document；客户端不能选择任意正文作为current policy；
- policy access只投影role、booleans与允许subject，不返回membership row、actor/source identity或fingerprint；
- RSC只序列化既有最小active/signal/candidate DTO，不把Drizzle row传给Client Component；
- active、signal、candidate使用独立cursor；客户端追加时按id去重；
- 时间显示固定UTC formatter，避免Server/浏览器时区导致hydration差异；
- 长列表item使用`content-visibility: auto`，不改变可访问DOM或API page上限。

## 当前证据

- contracts 31/31与typecheck通过；
- Web 65/65，覆盖registry、capability、policy endpoint、readiness、parallel loader、viewer隐藏、conflict replacement、visible consent与destructive confirmation；
- Web lint、typecheck与Next production build通过；
- DB targeted 27/27、typecheck与migration check通过；migration只增加`memory_source_signals(workspace_id, created_by_principal_id, id)`索引；
- 真实PostgreSQL 21/21、checkpoint 4/4、live sampler 1/1；own signal cursor逐页有界、无重复，并与完整author集合一致；
- 根级`pnpm verify`通过：DB 123、Worker 87、FastAPI 50及全部Memory/Eval/Workflow gate绿色；176份Markdown链接与`git diff --check`通过；
- calibration仍按设计返回`no_go/configuration_required`；本轮未调用真实provider。

## 尚未证明

- 真实浏览器通过trusted proxy登录后的端到端交互与header stripping；
- production非owner API role、托管部署与可访问性人工审查；
- 大规模真实数据下的查询计划、交互延迟与批量治理需求；
- 真实模型quality/cost、shadow consumer、retrieval与answer uplift。
