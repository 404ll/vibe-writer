export const STYLE_PROMPTS = {
  技术博客: '写作风格：面向有经验的开发者，逻辑严密，代码示例充足，避免废话。',
  科普: '写作风格：面向普通读者，多用类比和生活化比喻，避免术语堆砌。',
  教程: '写作风格：手把手教学，步骤清晰，每步有预期结果，适合初学者跟随操作。',
} as const

/** 自定义风格不能只是一个裸标签，否则 Planner 与 Writer 很容易把它当作无关元数据。 */
export function writerStyleInstruction(style?: string): string {
  if (!style) return ''
  return STYLE_PROMPTS[style as keyof typeof STYLE_PROMPTS]
    ?? `写作风格（用户自定义）：${style}。请在标题措辞、例子、转场与句式中持续体现，同时保持事实准确。`
}
