from fastapi import APIRouter, HTTPException
from sqlalchemy import select
from backend.database import AsyncSessionLocal
from backend.models_db import Article, ArticleVersion
from backend.models import ArticlePatchRequest

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


@router.patch("/{article_id}")
async def patch_article(article_id: str, req: ArticlePatchRequest):
    """更新文章内容，同时追加一条历史快照"""
    async with AsyncSessionLocal() as session:
        article = await session.get(Article, article_id)
        if not article:
            raise HTTPException(status_code=404, detail="Article not found")
        # 先把当前内容存为历史快照，再覆盖，防止原始版本丢失
        old_version = ArticleVersion(
            article_id=article_id,
            content=article.content,
            word_count=article.word_count,
        )
        session.add(old_version)
        article.content = req.content
        article.word_count = len(req.content.replace(" ", ""))
        await session.commit()
    return {"status": "ok"}


@router.get("/{article_id}/versions")
async def list_versions(article_id: str):
    """返回该文章所有历史快照（不含全文），按时间降序"""
    async with AsyncSessionLocal() as session:
        article = await session.get(Article, article_id)
        if not article:
            raise HTTPException(status_code=404, detail="Article not found")
        result = await session.execute(
            select(ArticleVersion)
            .where(ArticleVersion.article_id == article_id)
            .order_by(ArticleVersion.saved_at.desc())
        )
        versions = result.scalars().all()
    return {
        "versions": [
            {"id": v.id, "saved_at": v.saved_at.isoformat(), "word_count": v.word_count}
            for v in versions
        ]
    }


@router.get("/{article_id}/versions/{version_id}")
async def get_version(article_id: str, version_id: int):
    """返回某条历史快照的完整内容"""
    async with AsyncSessionLocal() as session:
        version = await session.get(ArticleVersion, version_id)
        if not version or version.article_id != article_id:
            raise HTTPException(status_code=404, detail="Version not found")
        return {"id": version.id, "content": version.content, "saved_at": version.saved_at.isoformat()}


@router.post("/{article_id}/versions/{version_id}/restore")
async def restore_version(article_id: str, version_id: int):
    """将某条历史恢复为当前版本（等同于一次 PATCH）"""
    async with AsyncSessionLocal() as session:
        version = await session.get(ArticleVersion, version_id)
        if not version or version.article_id != article_id:
            raise HTTPException(status_code=404, detail="Version not found")
        article = await session.get(Article, article_id)
        if not article:
            raise HTTPException(status_code=404, detail="Article not found")
        article.content = version.content
        article.word_count = version.word_count
        new_version = ArticleVersion(
            article_id=article_id,
            content=version.content,
            word_count=version.word_count,
        )
        session.add(new_version)
        await session.commit()
    return {"status": "ok"}
