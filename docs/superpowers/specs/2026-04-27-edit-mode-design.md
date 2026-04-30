# 文章编辑态 + 历史版本 + Mermaid 配图 设计文档

**日期：** 2026-04-27

---

## 概述

为 vibe-writer 结果页新增三个功能：

1. **编辑态**：用户可对生成的文章进行左右分栏编辑（左预览、右 Markdown）
2. **历史版本**：每次手动保存生成全文快照，支持回溯
3. **Mermaid 配图**：WriterAgent 在写作过程中自主决定是否为章节生成 Mermaid 图

---

## 1. 编辑态（Edit Mode）

### 入口 / 出口

- 结果页 Toolbar 右侧有「✎ 编辑」按钮
- 点击后进入编辑态，Toolbar 切换为「✓ 保存」「✕ 取消」
- **保存**：将当前 content 写入数据库，同时追加一条历史快照，退出编辑态
- **取消**：丢弃本次修改，退出编辑态（前端 state 回滚，不写库）

### 布局（方案 B：左右分栏）

```
┌─────────────────────────────────────────────┐
│  LangGraph 入门          [✓ 保存] [✕ 取消]  │
├──────────────────────┬──────────────────────┤
│   预览（渲染后）      │  编辑 Markdown        │
│                      │                      │
│  ## 核心概念          │  ## 核心概念          │
│  LangGraph 是...      │  LangGraph 是...      │
│                      │                      │
│  [Mermaid 图渲染]     │  ```mermaid          │
│                      │  graph TD...         │
│                      │  ```                 │
└──────────────────────┴──────────────────────┘
```

- 左栏：只读，实时渲染 Markdown（含 Mermaid）
- 右栏：可编辑 textarea，用户输入后左栏实时同步
- 两栏等宽，响应式：移动端折叠为单栏（仅编辑）

### 数据流

```
用户编辑 textarea
  → React state 更新（本地，不写库）
  → 左栏实时预览
  → 点「保存」
      → PATCH /articles/:id  { content: "..." }
      → 后端：更新 articles.content + 插入 article_versions
      → 前端：退出编辑态，显示最新内容
```

---

## 2. 历史版本（Version History）

### 数据库

新增表 `article_versions`：

```sql
CREATE TABLE article_versions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL REFERENCES articles(id),
    content   TEXT NOT NULL,
    saved_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

`articles` 表无需改动，`content` 字段始终是最新版。

### API

| 方法 | 路径 | 说明 |
|------|------|------|
| `PATCH` | `/articles/:id` | 更新内容，同时插入一条 version |
| `GET` | `/articles/:id/versions` | 返回该文章所有历史快照（id, saved_at, 字数） |
| `GET` | `/articles/:id/versions/:vid` | 返回某条历史的完整 content |
| `POST` | `/articles/:id/versions/:vid/restore` | 将某条历史恢复为当前版本（等同于一次 PATCH） |

### 前端交互

- 结果页 Toolbar 有「历史」按钮，点击展开侧边栏
- 侧边栏列出所有快照：时间 + 字数
- 点击某条快照：右侧预览该版本内容
- 「恢复此版本」按钮：调用 restore API，更新当前显示内容

---

## 3. Mermaid 配图（WriterAgent tool_use）

### 设计原则

配图判断是写作过程的一部分，由 WriterAgent 的 LLM 自主决定，而非独立 Agent。原因：

- 判断逻辑（"这章适不适合配图"）属于写作上下文，Writer 最了解
- Mermaid 代码生成是一次性原子操作，无需多轮 ReAct loop
- 保持 Agent 边界清晰：Writer 负责内容，包括图表

### 工具定义

在 `WriterAgent` 的工具列表中新增 `generate_diagram`：

```python
{
    "name": "generate_diagram",
    "description": (
        "为当前章节生成一张 Mermaid 图表。"
        "当章节涉及流程、架构、状态机、时序等结构性内容时使用。"
        "纯概念性或叙述性章节不需要配图。"
    ),
    "input_schema": {
        "type": "object",
        "required": ["diagram_type", "mermaid_code"],
        "properties": {
            "diagram_type": {
                "type": "string",
                "enum": ["flowchart", "sequenceDiagram", "stateDiagram", "graph"],
                "description": "图表类型"
            },
            "mermaid_code": {
                "type": "string",
                "description": "完整的 Mermaid 代码，不含 ```mermaid 包裹"
            }
        }
    }
}
```

### 执行逻辑

`WriterAgent` 的 tool_use 处理中，新增 `generate_diagram` 分支：

```python
elif tool_name == "generate_diagram":
    mermaid_code = tool_input["mermaid_code"]
    diagram_type = tool_input["diagram_type"]
    # 返回格式化后的 fenced code block，LLM 将其插入章节内容
    result = f"```mermaid\n{mermaid_code}\n```"
```

LLM 收到 tool_result 后，将 Mermaid 代码块插入章节正文的合适位置。

### 前端渲染

- 引入 `mermaid.js`，在 Markdown 渲染后对 ` ```mermaid ` 代码块调用 `mermaid.render()`
- 编辑态左栏预览同样渲染 Mermaid

---

## 4. 后端改动汇总

| 文件 | 改动 |
|------|------|
| `backend/database.py` | 新增 `article_versions` 表建表语句 |
| `backend/models_db.py` | 新增 `ArticleVersion` ORM 模型 |
| `backend/routers/articles.py` | 新增 `PATCH /:id`、`GET /:id/versions`、`GET /:id/versions/:vid`、`POST /:id/versions/:vid/restore` |
| `backend/agent/writer.py` | 工具列表新增 `generate_diagram`，tool_use 处理新增分支 |
| `backend/agent/prompts.py` | WriterAgent prompt 提示词中说明配图工具的使用时机 |

## 5. 前端改动汇总

| 文件 | 改动 |
|------|------|
| `frontend/src/components/ArticleView.tsx` | 新增编辑态切换逻辑、左右分栏布局 |
| `frontend/src/components/VersionHistory.tsx` | 新增历史版本侧边栏组件 |
| `frontend/src/hooks/useArticleEdit.ts` | 封装编辑态 state、保存/取消逻辑 |
| `frontend/src/api.ts` | 新增 patchArticle、getVersions、restoreVersion 接口 |
| `frontend/index.html` 或入口 | 引入 mermaid.js |

---

## 6. 不在本次范围内

- 多人协作编辑（冲突解决）
- 版本 diff 对比视图
- 配图样式自定义
- 移动端编辑优化
