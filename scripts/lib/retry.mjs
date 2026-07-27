const DEFAULT_DELAYS = [1000, 2000, 4000, 8000];

function errorStatus(error) {
  return Number(error?.status ?? error?.statusCode ??
    String(error?.message ?? "").match(/\b([45]\d\d)\b/)?.[1]);
}

function headerValue(error, name) {
  const headers = error?.headers ?? error?.response?.headers;
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? headers.get(name.toLowerCase());
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

function isRateLimited(error) {
  const message = String(error?.message ?? error?.response?.data?.message ?? "");
  const status = errorStatus(error);
  if (status === 403) {
    return headerValue(error, "retry-after") !== undefined ||
      headerValue(error, "x-ratelimit-remaining") === "0" ||
      /secondary rate limit/i.test(message);
  }
  return /secondary rate limit|abuse detection|abuse|spammed|spam/i.test(message) ||
    headerValue(error, "retry-after") !== undefined;
}

export function isTransientGitHubError(error) {
  const status = errorStatus(error);
  if (status === 403 || status === 422) return isRateLimited(error);
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/i.test(String(error?.message ?? ""));
}

export function retryDelayMilliseconds(error, fallback, {now = Date.now} = {}) {
  const retryAfter = headerValue(error, "retry-after");
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - now());
  }
  const reset = Number(headerValue(error, "x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset >= 0) return Math.max(0, reset * 1000 - now());
  return fallback;
}

export async function withRetry(operation, {
  delays = DEFAULT_DELAYS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  shouldRetry = isTransientGitHubError,
  now = Date.now
} = {}) {
  const retryDelays = Array.isArray(delays) ? delays.slice(0, 4) : DEFAULT_DELAYS;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === retryDelays.length || !shouldRetry(error)) throw error;
      await sleep(retryDelayMilliseconds(error, retryDelays[attempt], {now}));
    }
  }
  throw new Error("Retry loop exhausted");
}
