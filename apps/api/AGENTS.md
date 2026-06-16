# 后端开发 Agent 规范

这份文档适用于 `apps/api/` 下的后端开发任务。

## 技术栈与边界

- Web 框架：FastAPI。
- Agent 编排：LangGraph。
- 数据层：SQLAlchemy async + aiosqlite。
- 数据模型：Pydantic。
- 测试：pytest + pytest-asyncio。
- Python 包名保持为 `backend`，不要改成 `api`。

## 目录约定

- `backend/main.py`：FastAPI 应用入口和 router 注册。
- `backend/routers/`：HTTP API。
- `backend/agent/`：Planner、Opinion、Writer、Search、Reviewer 和 LangGraph 流程。
- `backend/database.py`、`backend/models_db.py`：数据库连接和 ORM 模型。
- `backend/models.py`：请求/状态模型。
- `tests/`：后端测试。

## 开发规则

- 修改 API 行为时，同步检查 `apps/web/src/api.ts` 和相关前端调用；如果不需要同步，最终说明原因。
- 不随意修改 prompt、tool schema、LangGraph 节点流转或 LLM 调用协议，除非任务明确要求。
- 不把外部 API 调用写进单元测试；使用 mock。
- 不在业务代码中硬编码密钥、模型账号或本地绝对路径。
- 数据库结构变化要说明是否需要迁移；当前项目仍以 `create_all` 为开发期建表方式。

## 常用命令

从仓库根目录：

```bash
pnpm test:api
```

从 `apps/api`：

```bash
../../.venv/bin/python -m pytest
../../.venv/bin/python -m pytest tests/test_jobs_router.py -v
../../.venv/bin/python -m uvicorn backend.main:app --reload
```

## 验证与既有失败

- `pnpm test:api` 当前可以收集并运行测试，但存在既有失败。
- 已知失败集中在 Agent/LLM mock 与 `backend.agent.base._extract_text_from_content()` 的结构预期不一致。
- 如果任务不是修复这些测试，不要顺手改 Agent 基类或测试 mock 来追求全绿。
- 后端变更完成时，优先运行相关 pytest 目标；必要时再运行 `pnpm test:api` 并报告剩余既有失败。

