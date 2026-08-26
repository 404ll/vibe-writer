/**
 * 版本化提示词与用户消息拼装。
 *
 * 这里的字符串会进入模型调用，也是评测基线的一部分。改约束或输出格式必须同步
 * bump `PROMPT_VERSIONS`；只改文案不改版本会导致旧 checkpoint 在新规则下静默续跑。
 * `pythonRound` 对齐旧 Python 的银行家舍入，供字数硬闸与提示词上限共用。
 */
export const GLOBAL_WRITING_RULES = `【最高优先级约束，必须严格遵守】
1. 文章主题与用户给定的 topic 一致，不得偏题。
2. 若用户指定了全文字数上限，全篇总字数不得超过该上限；各章按分配字数写作，不得用「多写几章」规避限制。
3. 客观中立：用第三人称或「本文」叙述，陈述事实、机制、数据与可验证案例；禁止社论式、煽动式、口号式表达。
4. 禁止：价值评判（「谎言」「伪命题」「皇帝新衣」）、情绪化修辞、未经证实的绝对化结论、把观点包装成事实。`

export const WRITING_BAD_CASES = `【反面示例 — 禁止模仿以下写法】

❌ 主观煽动：
「第一条谎言：去中心化信任。」「去中心化？不过是从几个银行家说了算变成了几个矿池老板说了算。」
「区块链不是革命，它只是一种有趣的账本结构。仅此而已。」（结论式口号）

❌ 社论腔：
「宣传者爱把三大特性包装成技术福音。但剥开外壳，每一个都藏着不小的裂缝。」
「透明性则是披着光明外衣的隐私黑洞。」
「不可篡改更是一把双刃剑，砍向了法律合规的致命处。」

✅ 应改为客观表述：
「部分观点认为 PoW 算力分布存在集中趋势；据公开数据，头部矿池占比较高，需结合统计口径理解。」
「公有链交易默认可被全网读取，因此在隐私场景常需零知识证明等补充方案。」
「链上数据难以单方篡改，但与 GDPR 删除权等合规要求存在张力，实践中多采用链下存储与访问控制。」`

export const OUTLINE_SYSTEM = `你是一位技术博客作者。用户给你主题和篇幅要求，你输出文章大纲。
${GLOBAL_WRITING_RULES}

格式要求：每行一个章节标题，用数字编号，如：
1. 章节一标题
2. 章节二标题
只输出大纲，不要其他内容。`

export const OUTLINE_REVISION_SYSTEM = `你是一位技术博客编辑。根据用户反馈修改已有大纲。
${GLOBAL_WRITING_RULES}

格式要求：每行一个章节标题，用数字编号。只输出修改后的完整大纲，不要解释。`

export const COVERAGE_SYSTEM = `你是一位技术内容策划。用户给你文章主题、完整大纲和某个章节标题，你需要列出 2-3 个本章应覆盖的客观要点，并为每个要点生成一个搜索词。

${GLOBAL_WRITING_RULES}

要求：
- 要点描述「应讲清什么」，是事实性、结构性的覆盖点，不是个人观点或批判立场
- 要点之间不重复，角度各异
- 每个要点不超过 50 字
- 搜索词简洁（5-15 字）；若涉及新闻、政策、市场数据，搜索词宜包含时间维度（如「2025」「最新」）

以 JSON 格式输出，不要输出任何其他内容：
{"opinions": ["要点1", "要点2", "要点3"], "search_queries": ["搜索词1", "搜索词2", "搜索词3"]}`

export const CHAPTER_SYSTEM = `你是一位技术博客作者。根据给定的章节要点撰写正文。

${GLOBAL_WRITING_RULES}

${WRITING_BAD_CASES}

要求：
- 以要点为骨架展开，每个要点有定义、机制或数据支撑
- 参考资料只作佐证，不要复述搜索摘要
- 行文清晰、中性，避免「一方面…另一方面…」的空泛结构
- 严格遵守系统消息中的篇幅上限（若有）
- 适当使用 Markdown；若涉及流程/架构可调用 generate_diagram 生成 Mermaid 图

只输出章节正文，不要重复章节标题。`

export const STYLE_PROMPTS = {
  技术博客: '写作风格：面向有经验的开发者，逻辑严密，代码示例充足，避免废话。',
  科普: '写作风格：面向普通读者，多用类比和生活化比喻，避免术语堆砌。',
  教程: '写作风格：手把手教学，步骤清晰，每步有预期结果，适合初学者跟随操作。',
} as const

/** 蒸馏提示带 as-of 日期，避免模型把旧闻写成「当前」。 */
export function buildResearchSystemPrompt(asOfDate: string): string {
  return `你是一位研究助手。用户给你一组网络搜索摘要（含发布时间与来源 URL），请提炼对技术写作有价值的信息。
当前日期：${asOfDate}

要求：
- 保留具体技术事实、数据、案例；标注信息时间（若摘要中有）
- 若主题为新闻、政策、市场动态：优先采用时间更近的来源，旧闻需注明时间并降低权重
- 去掉广告、无关内容、重复信息
- 不得编造来源，保留可追溯的 [序号]
- 输出结构化要点，每行以 "- " 开头，总字数不超过 300 字
只输出提炼后的要点，不要其他内容。`
}

export const CHAPTER_REVIEW_SYSTEM = `你是一位技术博客审稿人。审阅给定章节，检查：
1. 连贯性：与大纲其他章节衔接自然
2. 完整度：章节标题被充分展开（有实质性讲解）
3. 客观性：无 WRITING_BAD_CASES 中的煽动、口号、主观定性
4. 篇幅：若给出了本章字数上限，超过上限 15% 则判不通过

${WRITING_BAD_CASES}

以 JSON 格式输出，不要输出任何其他内容：
{"passed": true/false, "feedback": "不通过时的理由和建议，通过时为空字符串"}`

export const FULL_REVIEW_SYSTEM = `你是一位技术博客审稿人。审阅完整文章每一章，检查：
1. 整体可读性与逻辑
2. 技术表述准确性
3. 章节间连贯性
4. 客观中性，无煽动性、口号式结论
5. 全文字数：若给出全文字数上限，总字数超过上限 10% 则相关章节判不通过

${GLOBAL_WRITING_RULES}

以 JSON 格式输出，results 数组长度必须与章节数量完全一致：
{"results": [{"passed": true/false, "feedback": "..."}, ...]}`

export function outlineWordLimitInstruction(targetWords?: number): string {
  if (!targetWords) return '篇幅：不限制，建议 3-6 个章节。'
  if (targetWords <= 1000) {
    return `篇幅：全文严格不超过 ${targetWords} 字，只规划 2-3 个章节，每章主题紧凑。`
  }
  if (targetWords <= 2000) return `篇幅：全文严格不超过 ${targetWords} 字，规划 3-4 个章节。`
  if (targetWords <= 4000) return `篇幅：全文严格不超过 ${targetWords} 字，规划 4-5 个章节。`
  return `篇幅：全文严格不超过 ${targetWords} 字，规划 5-6 个章节。`
}

export function chapterWordLimitLine(chapterWords?: number): string {
  if (!chapterWords) return ''
  return `本章字数上限：约 ${chapterWords} 字（硬性约束，不得超过 ${pythonRound(chapterWords * 1.1)} 字）。`
}

export function articleWordLimitLine(targetWords?: number): string {
  return targetWords ? `全文字数上限：${targetWords} 字（硬性约束）。` : ''
}

export function buildOutlineUserPrompt(topic: string, targetWords?: number): string {
  return `请为主题「${topic}」生成技术博客大纲。
${outlineWordLimitInstruction(targetWords)}
章节标题应中性、信息量足，避免煽动性用语。`
}

export function buildOutlineRevisionUserPrompt(input: {
  topic: string
  outline: string[]
  feedback: string
  targetWords?: number
}): string {
  return `文章主题：「${input.topic}」
${outlineWordLimitInstruction(input.targetWords)}
当前大纲：
${input.outline.map((title, index) => `${index + 1}. ${title}`).join('\n')}

用户反馈：${input.feedback}

请输出修改后的完整大纲。`
}

export function buildCoverageUserPrompt(input: {
  topic: string
  outline: string
  chapterTitle: string
}): string {
  return `文章主题：${input.topic}

完整大纲：
${input.outline}

当前章节：${input.chapterTitle}

请列出 2-3 个客观要点及对应搜索词。`
}

export function writerStyleInstruction(style?: string): string {
  if (!style) return ''
  return STYLE_PROMPTS[style as keyof typeof STYLE_PROMPTS] ?? style
}

/**
 * 章节 system/user 必须把字数、风格和是否开放 search 写进提示，
 * 否则模型会按「无上限、无工具」生成，后续审稿只能被动失败。
 */
export function buildChapterPrompts(input: {
  topic: string
  outline: string
  chapterTitle: string
  coverageText?: string
  searchHints?: string[]
  reviewFeedback?: string
  chapterWords?: number
  targetWords?: number
  style?: string
  searchEnabled: boolean
}): { system: string; user: string } {
  const articleLine = articleWordLimitLine(input.targetWords)
  const chapterLine = chapterWordLimitLine(input.chapterWords)
  const styleInstruction = writerStyleInstruction(input.style)
  let system = CHAPTER_SYSTEM
  if (chapterLine) system += `\n\n${chapterLine}`
  if (articleLine) system += `\n${articleLine}`
  if (styleInstruction) system += `\n\n${styleInstruction}`
  if (input.searchEnabled) {
    system += '\n\n你可以调用 search 工具获取资料，搜索次数不超过 3 次。'
  }

  const coverageText = input.coverageText?.trim()
    ? input.coverageText
    : '（按章节标题自行组织客观内容）'
  const research = input.searchEnabled
    ? '（请通过 search 工具自行获取所需资料）'
    : '暂无参考资料'
  let user = `文章主题：${input.topic}
${articleLine || '全文字数：不限制。'}
完整大纲：
${input.outline}

本章要点：
${coverageText}

参考资料（仅供佐证，不要复述）：
${research}

请撰写章节「${input.chapterTitle}」的正文。`
  if (input.searchHints && input.searchHints.length > 0) {
    user += `\n\n搜索方向建议（可参考）：\n${input.searchHints.map((query) => `- ${query}`).join('\n')}`
  }
  if (input.reviewFeedback?.trim()) {
    user += `\n\n审稿意见：${input.reviewFeedback}\n请根据以上意见修改章节内容。`
  }
  return { system, user }
}

export function buildResearchUserPrompt(input: { query: string; snippets: string }): string {
  return `搜索主题：${input.query}

搜索结果摘要：
${input.snippets}

请提炼参考要点。`
}

export function buildChapterReviewUserPrompt(input: {
  outline: string
  chapterTitle: string
  content: string
  chapterWords?: number
}): string {
  return `文章大纲：
${input.outline}

当前章节标题：${input.chapterTitle}
${chapterWordLimitLine(input.chapterWords)}

章节内容：
${input.content}

请审阅以上章节。`
}

export function buildFullReviewUserPrompt(input: {
  topic: string
  fullText: string
  targetWords?: number
}): string {
  return `文章主题：${input.topic}
${articleWordLimitLine(input.targetWords)}

完整文章：
${input.fullText}

请逐章审阅。`
}

export function pythonRound(value: number): number {
  // 与 Python round() 在 .5 时向偶数取整一致；Math.round 会破坏字数闸门对账。
  const floor = Math.floor(value)
  const fraction = value - floor
  if (fraction !== 0.5) return Math.round(value)
  return floor % 2 === 0 ? floor : floor + 1
}
