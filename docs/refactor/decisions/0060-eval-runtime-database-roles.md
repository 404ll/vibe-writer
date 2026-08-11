# ADR-0060：Eval Runtime 独立数据库角色与 Content-free Column Boundary

- 状态：Accepted
- 日期：2026-08-10

## 背景

Eval queue dispatcher、consumer和live sampler已经是独立进程/loop，但仍共同读取`EVAL_DATABASE_URL`。dispatcher只发布`eval_run` outbox pointer；consumer跨synthetic与workspace suite领取run、读取case、执行grader并提交trial/score；sampler跨workspace扫描completed run并创建content-free candidate。三者的信任级别和数据需求不同，复用owner或同一service role会让队列发布故障、付费grader故障和全局采样故障共享数据库爆炸半径。

live sampler还有比table级最小权限更严格的隐私边界：SQL只需要Article identity、revision和content fingerprint，不需要`topic/content`；Job也只需要workspace/status，Run只需要完成游标字段。如果直接授予`SELECT articles/jobs/runs`，数据库凭据仍可绕过repository读取用户正文、topic或完整execution snapshot，与“sampler只产生content-free pointer”的系统承诺不一致。

## 决定

1. Eval dispatcher使用独立`DATABASE_EVAL_DISPATCHER_URL`与`EVAL_DISPATCHER_DATABASE_ROLE`。角色为`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`，仅有`outbox_events SELECT/UPDATE`。
2. Eval consumer使用独立`DATABASE_EVAL_CONSUMER_URL`与`EVAL_CONSUMER_DATABASE_ROLE`。由于它同时处理system synthetic suite和多个workspace的approved live suite，没有终端用户RLS session，显式使用`BYPASSRLS`；精确table权限为：
   - `eval_runs SELECT/UPDATE`；
   - `eval_suites/eval_cases/eval_candidates/memory_calibration_authorizations SELECT`；
   - `eval_trials INSERT`并仅额外`SELECT id`用于`RETURNING`；
   - `eval_scores INSERT`；
   - 不授予outbox、Job、Article、Memory正文、sampling policy、authorization event、DELETE、DDL或sequence权限。
3. live sampler使用独立`DATABASE_EVAL_LIVE_SAMPLER_URL`与`EVAL_LIVE_SAMPLER_DATABASE_ROLE`，同样显式`BYPASSRLS`。它只获得：
   - `eval_sampling_policies SELECT/UPDATE`；
   - `eval_candidates SELECT/INSERT`与`eval_candidate_events INSERT`；
   - `jobs(id, workspace_id, status)`、`runs(id, job_id, status, finished_at)`、`articles(id, job_id, source_run_id, revision, content_fingerprint)`的column-level `SELECT`；
   - 不得读取`jobs.topic`、Run execution snapshot或`articles.topic/content`。
4. PostgreSQL role contract引擎扩展column-level privilege manifest。provision必须同时清除受管schema中的table级和残留column级grant，再按manifest授予；verifier从current connection枚举有效table、column、sequence和schema权限，table级权限隐含的column能力不重复计为column grant。
5. `EVAL_QUEUE_ROLE=all`只合并进程拓扑，不合并数据库身份；必须提供两个不同URL与role。live sampler始终是第三套独立身份。所有runtime都不得回退`EVAL_DATABASE_URL`或owner连接。
6. queue和sampler runtime在启动业务loop前，从各自连接校验current user、精确有效权限、`BYPASSRLS`属性、membership、ownership和schema完整性。CLI verify只是部署预检，不能替代每个实例的startup verification。
7. 真实canary必须由owner负责migration、role creation/provision和seed；Eval dispatcher/consumer通过真实PostgreSQL+Redis完成pointer delivery与report commit，sampler通过真实PostgreSQL创建content-free candidate。负例至少证明dispatcher不能读Eval run、consumer不能读outbox、sampler不能读Article正文，三者不能创建schema。

## 结果与限制

三类Eval凭据可以独立轮换、撤销与限制连接来源；sampler的content-free边界由数据库column ACL而非仅靠代码约定保护。consumer仍必须读取approved `eval_cases.input`才能执行live grader，因此是可接触受治理用户内容的高信任角色；`BYPASSRLS`风险由精确对象权限、独立凭据、approval/retention重检和无任意target registry共同收口。

column-level verifier只声明manifest管理schema内的有效权限，不替代审计日志、加密、备份、网络策略或secret rotation。本决策不定义人工register/enqueue/authorization CLI、CI artifact uploader、migration或ops查询角色；它们后续按交互式/部署职责单独设计，不能复用runtime凭据。

## 回滚

停止对应Eval runtime并撤销role login；保留PostgreSQL run/candidate/report和Redis证据。不得用owner URL绕过startup verifier。若旧artifact只接受`EVAL_DATABASE_URL`，应保持runtime停机或回滚到受控隔离环境，不把三套凭据合并。权限回滚通过对应版本provisioner重新收敛；不得恢复`PUBLIC` schema CREATE或给sampler整表Article读取。
