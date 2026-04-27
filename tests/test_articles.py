# tests/test_articles.py
import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from backend.main import app

@pytest_asyncio.fixture(autouse=True)
async def reset_db():
    """每个测试前重建表结构"""
    from backend.database import engine, Base
    import backend.models_db  # noqa
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield

@pytest.mark.asyncio
async def test_article_versions_table_exists():
    """PATCH 保存后能查到版本列表"""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 先创建一篇文章（直接写库）
        from backend.database import AsyncSessionLocal
        from backend.models_db import Article
        async with AsyncSessionLocal() as session:
            article = Article(job_id="test-job-v1", topic="test", content="initial", word_count=7)
            session.add(article)
            await session.commit()
            await session.refresh(article)
            article_id = article.id

        # PATCH 更新内容
        resp = await client.patch(f"/articles/{article_id}", json={"content": "updated content"})
        assert resp.status_code == 200

        # 查版本列表
        resp = await client.get(f"/articles/{article_id}/versions")
        assert resp.status_code == 200
        versions = resp.json()["versions"]
        assert len(versions) >= 1
        assert "saved_at" in versions[0]
        assert "word_count" in versions[0]


@pytest.mark.asyncio
async def test_restore_version():
    """restore 后当前文章内容变成历史版本的内容"""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        from backend.database import AsyncSessionLocal
        from backend.models_db import Article
        async with AsyncSessionLocal() as session:
            article = Article(job_id="test-job-restore", topic="test", content="v1 content", word_count=10)
            session.add(article)
            await session.commit()
            await session.refresh(article)
            article_id = article.id

        # 保存 v2
        await client.patch(f"/articles/{article_id}", json={"content": "v2 content"})

        # 获取版本列表，拿到最新那条（v2 保存的）
        resp = await client.get(f"/articles/{article_id}/versions")
        versions = resp.json()["versions"]
        version_id = versions[0]["id"]  # 最新的一条

        # 恢复
        resp = await client.post(f"/articles/{article_id}/versions/{version_id}/restore")
        assert resp.status_code == 200

        # 当前内容应该等于 v2
        resp = await client.get(f"/articles/{article_id}")
        assert resp.json()["content"] == "v2 content"
