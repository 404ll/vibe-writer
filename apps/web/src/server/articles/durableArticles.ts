import type { ArticleRow, ArticleVersionRow } from '@vibe-writer/db'
import type {
  ArticleDetail,
  ArticleSummary,
  ArticleVersionDetail,
  ArticleVersionSummary,
} from '@vibe-writer/contracts/articles'

function iso(value: Date): string {
  return value.toISOString()
}

export function toArticleSummary(article: ArticleRow): ArticleSummary {
  return {
    id: article.id,
    job_id: article.jobId,
    topic: article.topic,
    word_count: article.wordCount,
    created_at: iso(article.createdAt),
    revision: article.revision,
  }
}

export function toArticleDetail(article: ArticleRow): ArticleDetail {
  return { ...toArticleSummary(article), content: article.content }
}

export function toVersionSummary(version: ArticleVersionRow): ArticleVersionSummary {
  return {
    id: version.id,
    saved_at: iso(version.savedAt),
    word_count: version.wordCount,
    source_revision: version.sourceRevision,
  }
}

export function toVersionDetail(version: ArticleVersionRow): ArticleVersionDetail {
  return {
    id: version.id,
    content: version.content,
    saved_at: iso(version.savedAt),
    source_revision: version.sourceRevision,
  }
}
