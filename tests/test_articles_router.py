# tests/test_articles_router.py
import pytest
import os
import uuid
import asyncio

# 必须在任何 backend import 之前设置，但由于模块缓存问题，
# 我们用 monkeypatch 或直接在每个测试里用独立 session
from fastapi.testclient import TestClient

@pytest.fixture
def client():
    from backend.main import app
    return TestClient(app)

@pytest.fixture(autouse=True)
def reset_db():
    """每个测试前重建内存表结构（用已有的内存 engine）"""
    from backend.database import engine, Base
    import backend.models_db  # noqa

    async def _reset():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

    asyncio.get_event_loop().run_until_complete(_reset())
    yield

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
