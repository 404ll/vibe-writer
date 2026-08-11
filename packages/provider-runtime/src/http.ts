export type ProviderFetch = typeof fetch

export function requestSignal(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void; timedOut(): boolean } {
  const controller = new AbortController()
  let timeout = false
  const onAbort = () => controller.abort(caller?.reason)
  caller?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timeout = true
    controller.abort(new DOMException('Provider request timed out.', 'TimeoutError'))
  }, timeoutMs)
  if (caller?.aborted) onAbort()
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      caller?.removeEventListener('abort', onAbort)
    },
    timedOut: () => timeout,
  }
}

export async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}
