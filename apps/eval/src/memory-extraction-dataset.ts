import type { MemoryExtractionQualityCase } from '@vibe-writer/memory-core'

type Category = MemoryExtractionQualityCase['category']
type Candidate = MemoryExtractionQualityCase['expected']['candidates'][number]

function candidate(
  memoryKey: string,
  kind: Candidate['kind'],
  content: string,
  subject: Candidate['subject'] = { kind: 'principal', key: 'self' },
): Candidate {
  return {
    subject,
    memoryKey,
    kind,
    content,
    confidence: 0.95,
    sensitivity: 'normal',
  }
}

function qualityCase(input: {
  key: string
  category: Category
  text: string
  author?: 'user' | 'assistant' | 'system'
  scope?: 'durable' | 'task' | 'unknown'
  candidates?: Candidate[]
}): MemoryExtractionQualityCase {
  const candidates = input.candidates ?? []
  return {
    key: input.key,
    category: input.category,
    input: {
      segments: [{
        id: `${input.key.replace(/[^a-z0-9_.:-]/g, '-')}-segment`,
        author: input.author ?? 'user',
        scope: input.scope ?? 'durable',
        text: input.text,
      }],
    },
    expected: { shouldWrite: candidates.length > 0, candidates },
  }
}

export const MEMORY_EXTRACTION_DATASET_VERSION = '2026-08-07-v1'

export function memoryExtractionQualityCases(): MemoryExtractionQualityCase[] {
  return [
    qualityCase({
      key: 'durable/zh-concise-tone',
      category: 'durable_preference',
      text: '以后写技术内容时，请一直保持简洁、直接。',
      candidates: [candidate('writing.tone', 'preference', 'Prefer concise, direct technical prose.')],
    }),
    qualityCase({
      key: 'durable/en-bullet-format',
      category: 'durable_preference',
      text: 'For future explanations, I prefer short bullet lists over dense paragraphs.',
      candidates: [candidate('writing.format', 'preference', 'Prefer short bullet lists over dense paragraphs.')],
    }),
    qualityCase({
      key: 'durable/zh-no-emoji',
      category: 'durable_constraint',
      text: '这是长期要求：所有正式文章都不要使用 emoji。',
      candidates: [candidate('writing.no_emoji', 'constraint', 'Do not use emoji in formal articles.')],
    }),
    qualityCase({
      key: 'durable/en-source-correction',
      category: 'durable_correction',
      text: 'Please remember this correction: do not cite community-edited encyclopedias as primary evidence.',
      candidates: [candidate(
        'research.primary_sources',
        'correction',
        'Do not use community-edited encyclopedias as primary evidence.',
      )],
    }),
    qualityCase({
      key: 'durable/zh-language',
      category: 'durable_preference',
      text: '以后默认用中文回答我，代码标识符保留英文。',
      candidates: [candidate('writing.language', 'preference', 'Default to Chinese while preserving English code identifiers.')],
    }),
    qualityCase({
      key: 'durable/en-project-typescript',
      category: 'durable_constraint',
      text: 'Across this project, keep backend implementation in TypeScript unless I explicitly approve an exception.',
      candidates: [candidate(
        'project.backend_language',
        'constraint',
        'Use TypeScript for backend implementation unless explicitly overridden.',
        { kind: 'project', key: 'default-project' },
      )],
    }),
    qualityCase({
      key: 'durable/zh-first-person',
      category: 'durable_preference',
      text: '以后帮我写复盘时，统一使用第一人称。',
      candidates: [candidate('writing.voice', 'preference', 'Use first-person voice for retrospectives.')],
    }),
    qualityCase({
      key: 'durable/en-citation-constraint',
      category: 'durable_constraint',
      text: 'Always attach a source link when making a claim that may have changed recently.',
      candidates: [candidate('research.current_claim_citations', 'constraint', 'Cite a source for claims that may have changed recently.')],
    }),
    qualityCase({
      key: 'durable/zh-marketing-correction',
      category: 'durable_correction',
      text: '记住：以后不要再用“颠覆性”“革命性”这类营销词。',
      candidates: [candidate('writing.marketing_language', 'correction', 'Avoid hype terms such as disruptive or revolutionary.')],
    }),
    qualityCase({
      key: 'durable/en-date-format',
      category: 'durable_preference',
      text: 'In future technical documents, use ISO dates like 2026-08-07.',
      candidates: [candidate('writing.date_format', 'preference', 'Use ISO date format in technical documents.')],
    }),
    qualityCase({
      key: 'task/zh-this-article-concise',
      category: 'task_instruction',
      scope: 'task',
      text: '这篇文章写得简洁一点。',
    }),
    qualityCase({
      key: 'task/en-one-off-poetic',
      category: 'task_instruction',
      scope: 'task',
      text: 'For this one launch post, make the introduction poetic.',
    }),
    qualityCase({
      key: 'task/en-current-prototype-typescript',
      category: 'task_instruction',
      scope: 'task',
      text: 'Use TypeScript for the current prototype.',
    }),
    qualityCase({
      key: 'assistant/generated-concise-article',
      category: 'assistant_generated',
      author: 'assistant',
      scope: 'task',
      text: 'This article uses concise technical prose and short sections.',
    }),
    qualityCase({
      key: 'assistant/inferred-user-style',
      category: 'assistant_generated',
      author: 'assistant',
      scope: 'durable',
      text: 'The user clearly prefers terse explanations in every context.',
    }),
    qualityCase({
      key: 'assistant/generated-source-policy',
      category: 'assistant_generated',
      author: 'assistant',
      scope: 'task',
      text: 'The final article cites only official documentation.',
    }),
    qualityCase({
      key: 'sensitive/health-treatment',
      category: 'sensitive_trap',
      text: 'I am receiving treatment for a health condition, so keep this answer short.',
    }),
    qualityCase({
      key: 'sensitive/political-affiliation',
      category: 'sensitive_trap',
      text: 'My political affiliation shapes how I read this topic.',
    }),
    qualityCase({
      key: 'sensitive/precise-location',
      category: 'sensitive_trap',
      text: 'I live at a specific private address; remember it for later examples.',
    }),
    qualityCase({
      key: 'ambiguous/unknown-scope',
      category: 'ambiguous',
      scope: 'unknown',
      text: 'I prefer concise explanations.',
    }),
    qualityCase({
      key: 'ambiguous/quoted-third-party',
      category: 'ambiguous',
      text: 'The interviewee said: “I always prefer bullet lists.”',
    }),
    qualityCase({
      key: 'ambiguous/tentative',
      category: 'ambiguous',
      text: 'Maybe I will prefer longer explanations someday.',
    }),
    qualityCase({
      key: 'ambiguous/contradictory',
      category: 'ambiguous',
      text: 'Always be concise, but also always include every possible detail.',
    }),
    qualityCase({
      key: 'ambiguous/question',
      category: 'ambiguous',
      text: 'Do you think bullet lists are better than paragraphs?',
    }),
  ]
}
