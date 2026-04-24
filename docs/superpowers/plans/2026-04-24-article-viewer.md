# Article Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将生成的文章存入 SQLite，前端支持历史列表点击跳转到独立文章阅读页，支持下载 .md 文件。

**Architecture:** 后端新增 `database.py`（SQLAlchemy async engine + `init_db`）和 `models_db.py`（Article ORM），Orchestrator EXPORT 阶段写文件后 INSERT article；新增 `/articles` router 提供列表和详情 API；前端引入 react-router-dom v6，新建 `ArticlePage.tsx`，HistoryPanel 改为从 API 拉取替换 localStorage。

**Tech Stack:** Python, SQLAlchemy 2.x async, aiosqlite, FastAPI, React 18, TypeScript, react-router-dom v6, react-markdown, remark-gfm

---

## File Map

| 文件 | 变更 |
|------|------|
| `backend/database.py` | 新建：engine、AsyncSession factory、Base、`init_db()` |
| `backend/models_db.py` | 新建：Article ORM model |
| `backend/routers/articles.py` | 新建：GET /articles, GET /articles/{id} |
| `backend/agent/orchestrator.py` | EXPORT 阶段写文件后 INSERT article |
| `backend/main.py` | 注册 articles router；startup 调用 `init_db()` |
| `requirements.txt` | 新增 `sqlalchemy[asyncio]`, `aiosqlite` |
| `frontend/src/pages/ArticlePage.tsx` | 新建：文章阅读页 |
| `frontend/src/api.ts` | 新建：`getArticles`, `getArticle` |
| `frontend/src/main.tsx` | 包裹 `<BrowserRouter>` |
| `frontend/src/App.tsx` | 改为 `<Routes>` 结构 |
| `frontend/src/components/HistoryPanel.tsx` | 改为从 API 拉取，删除 localStorage 逻辑 |
| `frontend/package.json` | 新增 `react-router-dom`, `react-markdown`, `remark-gfm` |

---

## Task 1: 后端 — 数据库层（database.py + models_db.py）

**Files:**
- Create: `backend/database.py`
- Create: `backend/models_db.py`
- Create: `tests/test_database.py`

- [ ] **Step 1: 新建 tests/test_database.py，写失败测试**

```python
# tests/test_database.py
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

@pytest.mark.asyncio
async def test_init_db_creates_articles_table():
    """init_db() 后可以向 articles 表 INSERT 并查询"""
    import os
    os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

    from backend.database import init_db, AsyncSessionLocal
    from backend.models_db import Article
    import uuid

    await init_db()

    async with AsyncSessionLocal() as session:
        article = Article(
            job_id=str(uuid.uuid4()),
            topic="测试主题",
            content="# 测试\n\n正文",
            word_count=4,
        )
        session.add(article)
        await session.commit()
        await session.refresh(article)
        assert article.id is not None
        assert article.topic == "测试主题"
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_database.py -v
```
Expected: FAIL（`backend.database` 模块不存在）

- [ ] **Step 3: 新建 backend/database.py**

```python
import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./data/vibe_writer.db")

engine = create_async_engine(DATABASE_URL, echo=False)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

async def init_db():
    """启动时调用，自动建表（表已存在则跳过）"""
    import os as _os
    # 确保 data/ 目录存在（内存数据库时跳过）
    if not DATABASE_URL.startswith("sqlite+aiosqlite:///:memory:"):
        _os.makedirs("data", exist_ok=True)
    from backend.models_db import Article  # noqa: F401 — 触发 Base 注册
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
```

- [ ] **Step 4: 新建 backend/models_db.py**

```python
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Text, Integer, DateTime
from sqlalchemy.orm import Mapped, mapped_column
from backend.database import Base

class Article(Base):
    __tablename__ = "articles"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    job_id: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    topic: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    word_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_database.py -v
```
Expected: 1 passed

- [ ] **Step 6: 运行全量测试确认无回归**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/ -v 2>&1 | tail -5
```
Expected: 全部通过

- [ ] **Step 7: 更新 requirements.txt**

在文件末尾追加：
```
sqlalchemy[asyncio]
aiosqlite
```

- [ ] **Step 8: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add backend/database.py backend/models_db.py tests/test_database.py requirements.txt
git commit -m "feat: add SQLite database layer — engine, Base, Article model, init_db"
```

---

## Task 2: 后端 — Articles API router

**Files:**
- Create: `backend/routers/articles.py`
- Create: `tests/test_articles_router.py`

- [ ] **Step 1: 新建 tests/test_articles_router.py，写失败测试**

```python
# tests/test_articles_router.py
import pytest
import os
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from fastapi.testclient import TestClient

@pytest.fixture(autouse=True)
def setup_db():
    """每个测试前重建内存数据库"""
    import asyncio
    from backend.database import init_db, engine, Base
    asyncio.get_event_loop().run_until_complete(init_db())
    yield
    # 清理：drop all tables
    async def _drop():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
    asyncio.get_event_loop().run_until_complete(_drop())

@pytest.fixture
def client():
    from backend.main import app
    return TestClient(app)

def test_get_articles_empty(client):
    """初始状态 GET /articles 返回空列表"""
    res = client.get("/articles")
    assert res.status_code == 200
    assert res.json() == []

def test_get_article_not_found(client):
    """不存在的 id 返回 404"""
    res = client.get("/articles/nonexistent-id")
    assert res.status_code == 404
    assert res.json()["detail"] == "Article not found"

def test_get_articles_and_detail(client):
    """插入一篇文章后，列表和详情均可正确返回"""
    import asyncio, uuid
    from backend.database import AsyncSessionLocal
    from backend.models_db import Article

    job_id = str(uuid.uuid4())

    async def _insert():
        async with AsyncSessionLocal() as session:
            article = Article(
                job_id=job_id,
                topic="RAG 检索增强生成",
                content="# RAG\n\n正文内容",
                word_count=10,
            )
            session.add(article)
            await session.commit()
            await session.refresh(article)
            return article.id

    article_id = asyncio.get_event_loop().run_until_complete(_insert())

    # 列表
    res = client.get("/articles")
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 1
    assert data[0]["topic"] == "RAG 检索增强生成"
    assert data[0]["word_count"] == 10
    assert "content" not in data[0]  # 列表不含全文

    # 详情
    res = client.get(f"/articles/{article_id}")
    assert res.status_code == 200
    detail = res.json()
    assert detail["content"] == "# RAG\n\n正文内容"
    assert detail["job_id"] == job_id
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_articles_router.py -v
```
Expected: FAIL（`/articles` 端点不存在）

- [ ] **Step 3: 新建 backend/routers/articles.py**

```python
from fastapi import APIRouter, HTTPException
from sqlalchemy import select
from backend.database import AsyncSessionLocal
from backend.models_db import Article

router = APIRouter(prefix="/articles")

@router.get("")
async def list_articles():
    """返回文章列表（不含全文），按 created_at 降序"""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Article).order_by(Article.created_at.desc())
        )
        articles = result.scalars().all()
    return [
        {
            "id": a.id,
            "job_id": a.job_id,
            "topic": a.topic,
            "word_count": a.word_count,
            "created_at": a.created_at.isoformat(),
        }
        for a in articles
    ]

@router.get("/{article_id}")
async def get_article(article_id: str):
    """返回单篇文章全文"""
    async with AsyncSessionLocal() as session:
        article = await session.get(Article, article_id)
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")
    return {
        "id": article.id,
        "job_id": article.job_id,
        "topic": article.topic,
        "content": article.content,
        "word_count": article.word_count,
        "created_at": article.created_at.isoformat(),
    }
```

- [ ] **Step 4: 修改 backend/main.py — 注册 articles router + startup init_db**

将 `backend/main.py` 完整替换为：

```python
from dotenv import load_dotenv
load_dotenv(override=True)

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

@asynccontextmanager
async def lifespan(app: FastAPI):
    from backend.database import init_db
    await init_db()
    yield

app = FastAPI(title="vibe-writer", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

from backend.routers.jobs import router as jobs_router
from backend.routers.articles import router as articles_router
app.include_router(jobs_router)
app.include_router(articles_router)

@app.get("/health")
async def health():
    return {"status": "ok"}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_articles_router.py -v
```
Expected: 3 passed

- [ ] **Step 6: 运行全量测试确认无回归**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/ -v 2>&1 | tail -5
```
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add backend/routers/articles.py backend/main.py tests/test_articles_router.py
git commit -m "feat: GET /articles and GET /articles/{id} endpoints"
```

---

## Task 3: 后端 — Orchestrator EXPORT 阶段写入数据库

**Files:**
- Modify: `backend/agent/orchestrator.py`
- Modify: `tests/test_orchestrator.py`

- [ ] **Step 1: 在 tests/test_orchestrator.py 末尾追加失败测试**

```python
@pytest.mark.asyncio
async def test_export_saves_article_to_db(monkeypatch):
    """EXPORT 阶段完成后，article 写入数据库"""
    import os
    os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

    from backend.database import init_db
    await init_db()

    events = []

    async def fake_push(job_id, event):
        events.append(event)

    monkeypatch.setattr("backend.agent.orchestrator.push_event", fake_push)

    mock_planner = MagicMock()
    mock_planner.plan = AsyncMock(return_value=["章节一"])
    mock_planner.parse_outline = MagicMock(return_value=[])

    mock_search = MagicMock()
    mock_search.search = AsyncMock(return_value="")

    mock_writer = MagicMock()
    mock_writer.write = AsyncMock(return_value="章节内容")

    from backend.agent.reviewer import ReviewResult
    mock_reviewer = MagicMock()
    mock_reviewer.review_chapter = AsyncMock(return_value=ReviewResult(passed=True, feedback=""))
    mock_reviewer.review_full = AsyncMock(return_value=[ReviewResult(passed=True, feedback="")])

    store = JobStore()
    job = store.create_job("测试主题")

    with patch("backend.agent.orchestrator.job_store", store), \
         patch("backend.agent.orchestrator.PlannerAgent", return_value=mock_planner), \
         patch("backend.agent.orchestrator.SearchAgent", return_value=mock_search), \
         patch("backend.agent.orchestrator.WriterAgent", return_value=mock_writer), \
         patch("backend.agent.orchestrator.ReviewAgent", return_value=mock_reviewer):
        orch = Orchestrator(job.id, "测试主题", intervention_on_outline=False)
        await orch.run()

    from backend.database import AsyncSessionLocal
    from backend.models_db import Article
    from sqlalchemy import select
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(Article).where(Article.job_id == job.id))
        article = result.scalar_one_or_none()

    assert article is not None
    assert article.topic == "测试主题"
    assert article.word_count > 0
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_orchestrator.py::test_export_saves_article_to_db -v
```
Expected: FAIL（Orchestrator EXPORT 阶段未写 DB）

- [ ] **Step 3: 修改 backend/agent/orchestrator.py — EXPORT 阶段追加 DB 写入**

在 `run` 方法的 EXPORT 阶段，找到写文件的代码：

```python
        markdown = self._build_markdown(self.topic, written_chapters)
        output_path = f"output/{self._safe_filename(self.topic)}.md"
        os.makedirs("output", exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(markdown)
```

替换为：

```python
        markdown = self._build_markdown(self.topic, written_chapters)
        output_path = f"output/{self._safe_filename(self.topic)}.md"
        os.makedirs("output", exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(markdown)

        # 写入数据库（失败不影响主流程）
        try:
            await self._save_article(job.id, self.topic, markdown)
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning("Failed to save article to DB: %s", e)
```

同时在 `Orchestrator` 类末尾（`_build_markdown` 之后）追加：

```python
    @staticmethod
    def _count_words(text: str) -> int:
        """简单字数统计：中文按字符数，英文按空格分词"""
        import re
        chinese = len(re.findall(r'[\u4e00-\u9fff]', text))
        english = len(re.findall(r'[a-zA-Z]+', text))
        return chinese + english

    @staticmethod
    async def _save_article(job_id: str, topic: str, content: str):
        from backend.database import AsyncSessionLocal
        from backend.models_db import Article
        word_count = Orchestrator._count_words(content)
        async with AsyncSessionLocal() as session:
            article = Article(
                job_id=job_id,
                topic=topic,
                content=content,
                word_count=word_count,
            )
            session.add(article)
            await session.commit()
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/test_orchestrator.py::test_export_saves_article_to_db -v
```
Expected: 1 passed

- [ ] **Step 5: 运行全量测试确认无回归**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/ -v 2>&1 | tail -5
```
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add backend/agent/orchestrator.py tests/test_orchestrator.py
git commit -m "feat: save article to SQLite after EXPORT stage"
```

---

## Task 4: 前端 — 安装依赖 + 路由 + api.ts

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/App.tsx`
- Create: `frontend/src/api.ts`

- [ ] **Step 1: 安装前端依赖**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer/frontend && npm install react-router-dom react-markdown remark-gfm
npm install --save-dev @types/react-router-dom
```

- [ ] **Step 2: 新建 frontend/src/api.ts**

```typescript
const API_BASE = 'http://localhost:8000'

export interface ArticleSummary {
  id: string
  job_id: string
  topic: string
  word_count: number
  created_at: string
}

export interface ArticleDetail extends ArticleSummary {
  content: string
}

export async function getArticles(): Promise<ArticleSummary[]> {
  const res = await fetch(`${API_BASE}/articles`)
  if (!res.ok) throw new Error('Failed to fetch articles')
  return res.json()
}

export async function getArticle(id: string): Promise<ArticleDetail> {
  const res = await fetch(`${API_BASE}/articles/${id}`)
  if (res.status === 404) throw new Error('Article not found')
  if (!res.ok) throw new Error('Failed to fetch article')
  return res.json()
}
```

- [ ] **Step 3: 修改 frontend/src/main.tsx — 包裹 BrowserRouter**

读取当前 `main.tsx` 内容，将其完整替换为：

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
```

- [ ] **Step 4: 修改 frontend/src/App.tsx — 加入 Routes 结构**

在文件顶部 import 区追加：
```typescript
import { Routes, Route } from 'react-router-dom'
import { ArticlePage } from './pages/ArticlePage'
```

将 `return (` 内的最外层 `<div>` 包裹改为：

```tsx
  return (
    <Routes>
      <Route path="/articles/:id" element={<ArticlePage />} />
      <Route path="/" element={
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          padding: '14px 16px',
          gap: '12px',
          minHeight: 0,
        }}>
          {/* ... 原有全部内容保持不变 ... */}
        </div>
      } />
    </Routes>
  )
```

注意：`/` route 的 `element` 内容就是原来 `return` 里的整个 `<div>`，原样保留，不做任何修改。

- [ ] **Step 5: 运行 TypeScript 类型检查**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer/frontend && npx tsc --noEmit 2>&1
```
Expected: 无错误（ArticlePage 尚未创建会报错，下一步创建后再确认）

- [ ] **Step 6: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add frontend/src/main.tsx frontend/src/App.tsx frontend/src/api.ts frontend/package.json frontend/package-lock.json
git commit -m "feat: add react-router-dom routing and api.ts for articles"
```

---

## Task 5: 前端 — ArticlePage

**Files:**
- Create: `frontend/src/pages/ArticlePage.tsx`
- Modify: `frontend/src/index.css`

- [ ] **Step 1: 新建 frontend/src/pages/ArticlePage.tsx**

```tsx
import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getArticle } from '../api'
import type { ArticleDetail } from '../api'

export function ArticlePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [article, setArticle] = useState<ArticleDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!id) return
    getArticle(id)
      .then(setArticle)
      .catch((e) => {
        if (e.message === 'Article not found') setNotFound(true)
      })
      .finally(() => setLoading(false))
  }, [id])

  function handleDownload() {
    if (!article) return
    const blob = new Blob([article.content], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${article.topic}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return (
      <div style={{ padding: '40px', maxWidth: '720px', margin: '0 auto' }}>
        <div className="skeleton" style={{ height: '28px', width: '60%', marginBottom: '16px' }} />
        <div className="skeleton" style={{ height: '16px', width: '100%', marginBottom: '8px' }} />
        <div className="skeleton" style={{ height: '16px', width: '90%', marginBottom: '8px' }} />
        <div className="skeleton" style={{ height: '16px', width: '80%' }} />
      </div>
    )
  }

  if (notFound || !article) {
    return (
      <div style={{ padding: '40px', maxWidth: '720px', margin: '0 auto', textAlign: 'center' }}>
        <p style={{ color: 'var(--text-muted)', marginBottom: '16px' }}>文章不存在</p>
        <button className="btn-primary" onClick={() => navigate('/')}>返回首页</button>
      </div>
    )
  }

  return (
    <div style={{ padding: '24px 16px', maxWidth: '720px', margin: '0 auto' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '24px',
        gap: '12px',
      }}>
        <button
          onClick={() => navigate('/')}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: '14px',
            color: 'var(--text-muted)',
            padding: '4px 0',
          }}
        >
          ← 返回
        </button>
        <span style={{
          flex: 1,
          fontWeight: 600,
          fontSize: '16px',
          color: 'var(--text-h)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {article.topic}
        </span>
        <button className="btn-primary" onClick={handleDownload} style={{ flexShrink: 0 }}>
          ↓ 下载
        </button>
      </div>

      {/* Markdown 渲染 */}
      <div className="prose">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {article.content}
        </ReactMarkdown>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 在 frontend/src/index.css 末尾追加 .prose 和 .skeleton 样式**

```css
/* ── Article prose styles ── */
.prose {
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.8;
  color: var(--text);
}
.prose h1, .prose h2, .prose h3 {
  font-family: var(--hand);
  color: var(--text-h);
  margin: 1.4em 0 0.5em;
  font-weight: 600;
}
.prose h1 { font-size: 1.6em; }
.prose h2 { font-size: 1.3em; }
.prose h3 { font-size: 1.1em; }
.prose p { margin: 0.8em 0; }
.prose ul, .prose ol { padding-left: 1.5em; margin: 0.8em 0; }
.prose li { margin: 0.3em 0; }
.prose code {
  background: var(--input-bg);
  border: 1px solid var(--border-input);
  border-radius: 3px;
  padding: 1px 5px;
  font-size: 13px;
  font-family: monospace;
}
.prose pre {
  background: var(--input-bg);
  border: 1px solid var(--border-input);
  border-radius: 6px;
  padding: 12px 16px;
  overflow-x: auto;
  margin: 1em 0;
}
.prose pre code {
  background: none;
  border: none;
  padding: 0;
}
.prose blockquote {
  border-left: 3px solid var(--accent);
  padding-left: 12px;
  color: var(--text-muted);
  margin: 0.8em 0;
}

/* ── Skeleton loader ── */
.skeleton {
  background: linear-gradient(90deg, var(--input-bg) 25%, var(--border-input) 50%, var(--input-bg) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
  border-radius: 4px;
}
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

- [ ] **Step 3: 运行 TypeScript 类型检查**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer/frontend && npx tsc --noEmit 2>&1
```
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add frontend/src/pages/ArticlePage.tsx frontend/src/index.css
git commit -m "feat: ArticlePage with Markdown rendering and download"
```

---

## Task 6: 前端 — HistoryPanel 改为从 API 拉取

**Files:**
- Modify: `frontend/src/components/HistoryPanel.tsx`

- [ ] **Step 1: 读取当前 HistoryPanel.tsx**

先读取文件确认当前实现，然后完整替换为：

```tsx
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { JobState } from '../types'
import { getArticles } from '../api'
import type { ArticleSummary } from '../api'

interface Props {
  currentJob: JobState | null
  currentTopic: string
}

export function HistoryPanel({ currentJob }: Props) {
  const navigate = useNavigate()
  const [articles, setArticles] = useState<ArticleSummary[]>([])
  const [loading, setLoading] = useState(true)

  async function fetchArticles() {
    try {
      const data = await getArticles()
      setArticles(data)
    } catch {
      // 静默失败
    } finally {
      setLoading(false)
    }
  }

  // 初始加载
  useEffect(() => {
    fetchArticles()
  }, [])

  // job 完成后重新拉取
  useEffect(() => {
    if (currentJob?.stage === 'done') {
      fetchArticles()
    }
  }, [currentJob?.stage])

  return (
    <div className="card" style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="card-label">历史文章</div>

      {loading ? (
        <div style={{ padding: '8px 0', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: '36px', borderRadius: '5px' }} />
          ))}
        </div>
      ) : articles.length === 0 ? (
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '8px 0' }}>暂无文章</p>
      ) : (
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {articles.map((a) => (
            <div
              key={a.id}
              onClick={() => navigate(`/articles/${a.id}`)}
              style={{
                padding: '8px 10px',
                borderRadius: '5px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '13px',
                color: 'var(--text)',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--input-bg)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{ color: 'var(--accent)', fontSize: '8px', flexShrink: 0 }}>●</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.topic}
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: '11px', flexShrink: 0 }}>
                {a.word_count} 字
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 运行 TypeScript 类型检查**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer/frontend && npx tsc --noEmit 2>&1
```
Expected: 无错误

- [ ] **Step 3: 运行全量后端测试确认无回归**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer && python3 -m pytest tests/ -v 2>&1 | tail -5
```
Expected: 全部通过

- [ ] **Step 4: Commit**

```bash
cd /Users/0xelemen/myself/practice/vibe-writer
git add frontend/src/components/HistoryPanel.tsx
git commit -m "feat: HistoryPanel fetches from GET /articles, navigate to ArticlePage on click"
```

---

## Self-Review Checklist

| Spec 要求 | Task |
|-----------|------|
| SQLite + aiosqlite + SQLAlchemy async | Task 1 |
| `articles` 表（id, job_id, topic, content, word_count, created_at） | Task 1 |
| 启动时 `create_all` 自动建表 | Task 1 + Task 2 Step 4 |
| `GET /articles` 返回列表（不含全文） | Task 2 |
| `GET /articles/:id` 返回全文 | Task 2 |
| 404 返回 `{"detail": "Article not found"}` | Task 2 |
| DB 写入失败不影响主流程 | Task 3 |
| EXPORT 阶段写入 DB | Task 3 |
| word_count 计算（中文字符 + 英文单词） | Task 3 |
| react-router-dom v6 路由 | Task 4 |
| `api.ts` 封装 getArticles / getArticle | Task 4 |
| ArticlePage：返回 + 下载 + Markdown 渲染 | Task 5 |
| 骨架屏 + 404 状态 | Task 5 |
| `.prose` 牛皮纸风格排版 | Task 5 |
| HistoryPanel 改为 API 拉取 | Task 6 |
| job done 后重新拉取列表 | Task 6 |
| 删除 localStorage 逻辑 | Task 6 |
