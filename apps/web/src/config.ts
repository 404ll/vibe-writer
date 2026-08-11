/** 默认走 Next.js 同源 rewrite；必要时可在构建期覆盖为外部 API。 */
export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? '/api').replace(/\/$/, '')
