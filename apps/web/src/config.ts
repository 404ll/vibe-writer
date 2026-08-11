/** Web 与 Next.js Route Handler 共用唯一的 TypeScript API。 */
export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? '/api/durable').replace(/\/$/, '')
