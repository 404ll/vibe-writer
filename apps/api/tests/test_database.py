# tests/test_database.py
import pytest
import pytest_asyncio
import uuid
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from backend.database import Base

@pytest_asyncio.fixture
async def db_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    import backend.models_db  # noqa — 触发 Base 注册
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    AsyncSession_ = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with AsyncSession_() as session:
        yield session
    await engine.dispose()

@pytest.mark.asyncio
async def test_init_db_creates_articles_table(db_session):
    """init_db 建表后可以 INSERT 并查询"""
    from backend.models_db import Article

    article = Article(
        job_id=str(uuid.uuid4()),
        topic="测试主题",
        content="# 测试\n\n正文",
        word_count=4,
    )
    db_session.add(article)
    await db_session.commit()
    await db_session.refresh(article)
    assert article.id is not None
    assert article.topic == "测试主题"
