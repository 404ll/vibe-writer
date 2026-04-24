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
