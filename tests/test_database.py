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
