export const HOME_ROUTE = '/'

export function articleRoute(articleId: string) {
  return `/articles/${encodeURIComponent(articleId)}`
}
