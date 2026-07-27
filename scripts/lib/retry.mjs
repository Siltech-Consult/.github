const DEFAULT_DELAYS = [1000, 2000, 4000, 8000];

function errorStatus(error) {
  return Number(error?.status ?? error?.statusCode ??
    String(error?.message ?? "").match(/\b([45]\d\d)\b/)?.[1]);
}

export function isTransientGitHubError(error) {
  const status = errorStatus(error);
  if (status === 403 || status === 408 || status === 409 || status === 425 || status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(String(error?.message ?? ""));
}

export async function withRetry(operation, {
  delays = DEFAULT_DELAYS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  shouldRetry = isTransientGitHubError
} = {}) {
  const retryDelays = Array.isArray(delays) ? delays.slice(0, 4) : DEFAULT_DELAYS;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === retryDelays.length || !shouldRetry(error)) throw error;
      await sleep(retryDelays[attempt]);
    }
  }
  throw new Error("Retry loop exhausted");
}
