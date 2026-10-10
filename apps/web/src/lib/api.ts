export const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number | null = null,
    public retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const cooldowns = new Map<
  string,
  { until: number; failures: number; error: ApiError }
>();
export function pollDelay(
  error: unknown,
  failures: number,
  normalMs = 5000,
  random = Math.random,
): number {
  const requested = error instanceof ApiError ? (error.retryAfterMs ?? 0) : 0;
  const base = error
    ? Math.min(60000, normalMs * 2 ** Math.min(failures, 4))
    : normalMs;
  return Math.ceil(
    Math.max(requested, base) + random() * Math.min(base * 0.2, 5000),
  );
}

function retryDelay(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const until = Date.parse(value);
  return Number.isFinite(until) ? Math.max(0, until - Date.now()) : null;
}

export async function fetchJson<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const savedCooldown = cooldowns.get(path);
  if (savedCooldown && savedCooldown.until > Date.now())
    throw new ApiError(
      savedCooldown.error.message,
      savedCooldown.error.status,
      savedCooldown.until - Date.now(),
    );
  const controller = new AbortController();
  const signal = options?.signal;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () =>
      controller.abort(new DOMException("Request timed out", "TimeoutError")),
    20_000,
  );
  const headers = new Headers(options?.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers,
    });
    if (!response.ok) {
      let message =
        response.status === 429
          ? "Too many requests. Please try again shortly."
          : "Could not reach the data source. Please try again.";
      try {
        const body: unknown = await response.json();
        if (
          body &&
          typeof body === "object" &&
          (("message" in body && typeof body.message === "string") ||
            ("error" in body && typeof body.error === "string"))
        ) {
          const detail =
            "message" in body
              ? body.message
              : "error" in body
                ? body.error
                : null;
          if (typeof detail === "string" && detail.trim())
            message = detail.trim().slice(0, 240);
        }
      } catch {
        /* Preserve the readable fallback for non-JSON error responses. */
      }
      const error = new ApiError(
        message,
        response.status,
        retryDelay(response.headers.get("Retry-After")),
      );
      if (response.status === 429 || response.status === 503) {
        const failures = (savedCooldown?.failures ?? 0) + 1;
        const delay = Math.max(
          error.retryAfterMs ?? 0,
          pollDelay(error, failures),
        );
        cooldowns.delete(path);
        cooldowns.set(path, { until: Date.now() + delay, failures, error });
        if (cooldowns.size > 128)
          cooldowns.delete(cooldowns.keys().next().value!);
      }
      throw error;
    }
    try {
      const value = (await response.json()) as T;
      cooldowns.delete(path);
      return value;
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new ApiError(
        "The server returned an unreadable response. Please try again.",
      );
    }
  } catch (error) {
    if (signal?.aborted)
      throw signal.reason ?? new DOMException("Request aborted", "AbortError");
    if (controller.signal.aborted)
      throw new ApiError("The request timed out. Please try again.");
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "Could not reach the data source. Check your connection and try again.",
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
