# tests/test_articles_router.py
import pytest
import pytest_asyncio
import uuid

from fastapi.testclient import TestClient

@pytest.fixture
def client():
    from backend.main import app
    return TestClient(app)

@pytest_asyncio.fixture(autouse=True)
async def reset_db():
    """每个测试前重建表结构"""
    from backend.database import engine, Base
    import backend.models_db  # noqa
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
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

@pytest.mark.asyncio
async def test_get_articles_and_detail(client):
    """插入一篇文章后，列表和详情均可正确返回"""
    from backend.database import AsyncSessionLocal
    from backend.models_db import Article

    job_id = str(uuid.uuid4())
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
        article_id = article.id

    # 列表
    res = client.get("/articles")
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 1
    assert data[0]["topic"] == "RAG 检索增强生成"
    assert data[0]["word_count"] == 10
    assert "content" not in data[0]

    # 详情
    res = client.get(f"/articles/{article_id}")
    assert res.status_code == 200
    detail = res.json()
    assert detail["content"] == "# RAG\n\n正文内容"
    assert detail["job_id"] == job_id
