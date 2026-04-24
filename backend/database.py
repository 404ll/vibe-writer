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
    # 确保 data/ 目录存在（内存数据库时跳过）
    if not DATABASE_URL.startswith("sqlite+aiosqlite:///:memory:"):
        os.makedirs(os.path.join(os.path.dirname(__file__), "..", "data"), exist_ok=True)
    from backend.models_db import Article  # noqa: F401 — 触发 Base 注册
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
