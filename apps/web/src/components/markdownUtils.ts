/** 将 Markdown 标题转换成目录链接和正文 heading 共用的锚点。 */
export function slugifyHeading(text: string) {
  return text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '')
}
