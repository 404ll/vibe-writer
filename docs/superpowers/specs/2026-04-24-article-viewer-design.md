# Article Viewer Design

**Date:** 2026-04-24
**Scope:** 文章持久化存储 + 历史列表 + 文章阅读页（含 Markdown 渲染和下载）

---

## 目标

将生成的文章存入 PostgreSQL，前端支持历史列表点击跳转到独立文章阅读页，支持下载 .md 文件。面向云部署，文件系统不可靠，内容全量存数据库。

---

## 后端

### 数据库

- **SQLite**，通过 `aiosqlite` 驱动 + `SQLAlchemy 2.x async` ORM
- 启动时调用 `create_all` 自动建表，无需迁移工具
- 连接字符串通过环境变量 `DATABASE_URL` 注入，默认 `sqlite+aiosqlite:///./data/vibe_writer.db`

### Article 表

```sql
CREATE TABLE articles (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id     UUID NOT NULL UNIQUE,
    topic      TEXT NOT NULL,
    content    TEXT NOT NULL,
    word_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

字段说明：
- `job_id`：与 `JobState.id` 对应，UNIQUE 防止重复写入
- `content`：Markdown 全文
- `word_count`：写入时计算（中文按字符数，英文按空格分词）

### 新增文件

| 文件 | 职责 |
|------|------|
| `backend/database.py` | SQLAlchemy engine、session factory、Base、`init_db()` |
| `backend/models_db.py` | `Article` ORM model |
| `backend/routers/articles.py` | Articles API router |

### 改动现有文件

| 文件 | 改动 |
|------|------|
| `backend/models.py` | 无改动 |
| `backend/agent/orchestrator.py` | EXPORT 阶段写文件后，INSERT article 到 DB |
| `backend/main.py` | 注册 articles router；启动时初始化 DB 连接 |
| `requirements.txt` | 新增 `sqlalchemy[asyncio]`, `aiosqlite` |

### API

#### `GET /articles`

返回文章列表，不含全文，按 `created_at` 降序。

```json
[
  {
    "id": "uuid",
    "job_id": "uuid",
    "topic": "RAG 检索增强生成",
    "word_count": 3200,
    "created_at": "2026-04-24T14:32:00Z"
  }
]
```

#### `GET /articles/:id`

返回单篇文章全文。

```json
{
  "id": "uuid",
  "job_id": "uuid",
  "topic": "RAG 检索增强生成",
  "content": "# RAG 检索增强生成\n\n...",
  "word_count": 3200,
  "created_at": "2026-04-24T14:32:00Z"
}
```

错误：文章不存在返回 `404`。

### 错误处理

- DB 写入失败不影响主流程（orchestrator catch exception，记录日志，SSE `done` 事件正常发出）
- `GET /articles/:id` 找不到返回 `404 {"detail": "Article not found"}`

---

## 前端

### 路由

引入 `react-router-dom v6`。

```
/             → 现有主界面（App.tsx）
/articles/:id → 文章阅读页（ArticlePage.tsx）
```

入口 `main.tsx` 包裹 `<BrowserRouter>`，`App.tsx` 用 `<Routes>` 分发。

### HistoryPanel 改动

- 启动时 `GET /articles` 拉取列表，替换原来的 localStorage 方案
- 每次新 job 完成（`stage === 'done'`）后重新拉取列表（而不是手动追加）
- 每条记录显示：主题 + 字数 + 时间
- 点击 → `navigate('/articles/:id')`
- 加载中显示骨架占位；空状态显示"暂无文章"
- 删除 localStorage 相关代码（`loadHistory`, `saveHistory`, `STORAGE_KEY`）

### ArticlePage（新建）

**路由：** `/articles/:id`

**布局（牛皮纸风格，与主界面一致）：**

```
┌──────────────────────────────────────┐
│  ← 返回    RAG 检索增强生成   ↓ 下载  │  ← 顶部 toolbar
├──────────────────────────────────────┤
│                                      │
│   Markdown 渲染区域                   │  ← 主体，max-width: 720px 居中
│                                      │
└──────────────────────────────────────┘
```

**交互：**
- 返回按钮：`navigate(-1)` 或 `navigate('/')`
- 下载按钮：前端 Blob 下载，文件名 `{topic}.md`
- 加载中：显示骨架屏
- 404：显示"文章不存在"提示 + 返回按钮

**Markdown 渲染：**
- 库：`react-markdown` + `remark-gfm`
- 样式：在 `index.css` 加 `.prose` 类（标题、正文、代码块、列表的牛皮纸风格排版）

### 新增文件

| 文件 | 职责 |
|------|------|
| `frontend/src/pages/ArticlePage.tsx` | 文章阅读页 |
| `frontend/src/api.ts` | API 请求封装（`getArticles`, `getArticle`） |

### 改动现有文件

| 文件 | 改动 |
|------|------|
| `frontend/src/main.tsx` | 包裹 `<BrowserRouter>` |
| `frontend/src/App.tsx` | 改为 `<Routes>` 结构，`/` 和 `/articles/:id` 分发 |
| `frontend/src/components/HistoryPanel.tsx` | 改为从 API 拉取，删除 localStorage 逻辑 |
| `package.json` | 新增 `react-router-dom`, `react-markdown`, `remark-gfm` |

---

## 不在本次范围内

- 文章编辑
- 文章删除
- 搜索 / 过滤
- 分页（列表暂时全量返回，文章数量有限）
- 用户认证
