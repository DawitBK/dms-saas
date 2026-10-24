// shared/lib/apiClient.ts
// Axios-based API client. All requests automatically inject the Bearer token
// from the Zustand auth store.
// 401 responses trigger a single token-refresh attempt (POST /auth/refresh via
// HttpOnly cookie). If the refresh succeeds the original request is retried with
// the new token. If the refresh fails the session is cleared and AuthGuard
// redirects to /login.
import axios, { type AxiosRequestConfig, type AxiosError } from 'axios';
import { useAuthStore } from '../../state/auth.store';
import { API_BASE_URL } from './apiConfig';
import { LICENSE_ERROR, LICENSE_QUERY_KEY } from './license';
import { queryClient } from './queryClient';

const API_BASE = API_BASE_URL;

/** The shape of Zod's `error.flatten()`, as the backend's errorHandler
 *  attaches it under `details` for ERR-VALIDATION responses. */
export interface ApiErrorDetails {
  fieldErrors?: Record<string, string[]>;
  formErrors?: string[];
  [key: string]: unknown;
}

/**
 * Every API failure in this app used to arrive at UI code as a bare `Error`
 * with only `.message` — the backend's error `code`, structured `details`
 * (per-field Zod validation errors), and `requestId` were all read off the
 * response here and then thrown away, so no form could ever highlight the
 * specific invalid field and no toast could ever offer a support reference.
 * `ApiError extends Error` on purpose: every existing `catch (err) { ... }`
 * that does `err instanceof Error ? err.message : ...` keeps working
 * unchanged, while new code can check `err instanceof ApiError` to reach
 * `.code`/`.details`/`.requestId`/`.isNetworkError`.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: ApiErrorDetails;
  readonly requestId?: string;
  /** True when the request never reached a server at all (offline, DNS
   *  failure, connection refused, CORS, timeout) — as opposed to the server
   *  reaching a response and that response being an error. These need
   *  different copy: "the server said no" vs "we couldn't even ask". */
  readonly isNetworkError: boolean;

  constructor(
    message: string,
    opts: { code: string; status?: number; details?: ApiErrorDetails; requestId?: string; isNetworkError?: boolean },
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = opts.code;
    this.status = opts.status;
    this.details = opts.details;
    this.requestId = opts.requestId;
    this.isNetworkError = opts.isNetworkError ?? false;
  }
}

/** Turns an ERR-VALIDATION's per-field messages into one readable string —
 *  e.g. for a "live preview" panel that has nowhere else to show which part
 *  of what the author typed actually failed. Falls back to `.message` for
 *  every other error shape (network errors, non-ApiErrors, ERR-VALIDATION
 *  responses with no fieldErrors attached). */
export function describeApiError(e: unknown, fallback = 'Something went wrong'): string {
  if (e instanceof ApiError && e.details?.fieldErrors) {
    const messages = Object.values(e.details.fieldErrors).flat();
    if (messages.length > 0) return messages.join(' — ');
  }
  return e instanceof Error ? e.message : fallback;
}

const instance = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

// Request interceptor — inject Authorization header
instance.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Flag to prevent multiple concurrent refresh attempts
let isRefreshing = false;
// Queue of requests that arrived while a refresh was in-flight
let refreshQueue: Array<{ resolve: (token: string) => void; reject: (err: unknown) => void }> = [];

function processRefreshQueue(error: unknown, token: string | null) {
  refreshQueue.forEach((p) => {
    if (error) {
      p.reject(error);
    } else {
      p.resolve(token!);
    }
  });
  refreshQueue = [];
}

// Response interceptor — on 401, attempt a single silent refresh then retry.
instance.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as AxiosRequestConfig & { _retried?: boolean };

    if (error.response?.status === 401 && !originalRequest._retried) {
      originalRequest._retried = true;

      if (isRefreshing) {
        // Another refresh is already in-flight; queue this request.
        return new Promise((resolve, reject) => {
          refreshQueue.push({
            resolve: (newToken) => {
              if (originalRequest.headers) {
                (originalRequest.headers as any).Authorization = `Bearer ${newToken}`;
              } else {
                originalRequest.headers = { Authorization: `Bearer ${newToken}` };
              }
              resolve(instance.request(originalRequest));
            },
            reject,
          });
        });
      }

      isRefreshing = true;

      try {
        // POST /auth/refresh uses the HttpOnly refreshToken cookie (no body needed).
        const { data } = await axios.post<{ accessToken: string; user: { permissions: string[] } }>(
          `${API_BASE}/auth/refresh`,
          {},
          { withCredentials: true },
        );

        const newToken = data.accessToken;
        useAuthStore.getState().setSession({
          accessToken: newToken,
          permissions: data.user?.permissions ?? useAuthStore.getState().permissions,
        });

        processRefreshQueue(null, newToken);

        if (originalRequest.headers) {
          (originalRequest.headers as any).Authorization = `Bearer ${newToken}`;
        } else {
          originalRequest.headers = { Authorization: `Bearer ${newToken}` };
        }

        return instance.request(originalRequest);
      } catch (refreshError) {
        processRefreshQueue(refreshError, null);
        useAuthStore.getState().clearSession();
        // AuthGuard watches accessToken and redirects to /login — no hard redirect needed.
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    // No `error.response` at all means the request never reached a server —
    // offline, DNS failure, connection refused, CORS rejection, or a client-
    // side timeout. That is a fundamentally different situation from the
    // server responding with an error, and used to be indistinguishable:
    // both fell through to the same `error.message` (axios's own generic
    // "Network Error"), which every toast/banner in the app then displayed
    // as if it were a real API response.
    if (!error.response) {
      return Promise.reject(
        new ApiError('Cannot reach the server. Check your connection and try again.', {
          code: 'ERR-NETWORK',
          isNetworkError: true,
        }),
      );
    }

    // A request made through apiClientBlob/apiClientBlobResponse (document
    // downloads, PDF previews) sets `responseType: 'blob'` on the AXIOS
    // CONFIG — which axios also applies to an ERROR response on that same
    // request, not just a successful one. The backend still sends its usual
    // JSON error body (`{ error: { code, message, details } }`) on a 403/422/
    // 500, but axios hands it back here as an opaque `Blob`, not parsed JSON.
    // Every `body?.error?.message` lookup below then silently misses (a Blob
    // has no `.error` property) and falls through to axios's own generic
    // `error.message` ("Request failed with status code 403") — the real
    // backend reason (e.g. letters' ERR-DEPT-SCOPE) never reached the UI.
    // Confirmed live on the letters PDF preview endpoint (features/letters/
    // api.ts's previewLetterPdf, routed through apiClientBlob) 2026-09-21.
    let body = error.response.data as { error?: { code?: string; message?: string; details?: ApiErrorDetails; requestId?: string }; message?: string } | undefined;
    if (body instanceof Blob) {
      try {
        const text = await body.text();
        body = JSON.parse(text);
      } catch {
        // Not JSON-parseable — a genuinely binary error body (rare), or an
        // HTML error page from something in front of the API. Leave `body`
        // as the Blob; the lookups below miss and fall through to
        // `error.message`, same as before this fix for that case.
      }
    }
    const message = body?.error?.message ?? body?.message ?? error.message ?? 'Request failed';
    const code = body?.error?.code ?? 'ERR-UNKNOWN';
    // The licence went read-only (or lapsed entirely) while this page was open: refresh the banner now instead of at the next poll.
    if (code === LICENSE_ERROR.EXPIRED || code === LICENSE_ERROR.REQUIRED) void queryClient.invalidateQueries({ queryKey: LICENSE_QUERY_KEY });
    return Promise.reject(
      new ApiError(message, {
        code,
        status: error.response.status,
        details: body?.error?.details,
        requestId: body?.error?.requestId,
      }),
    );
  },
);

/**
 * Type-safe API client. Wraps axios with the same call signature as the
 * previous fetch-based implementation for backward compatibility.
 *
 * path    — API path (relative to NEXT_PUBLIC_API_BASE_URL), e.g. '/documents'
 * init    — Subset of RequestInit: method, body, headers
 */
export async function apiClient<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const isFormData =
    typeof FormData !== 'undefined' && init.body instanceof FormData;

  const config: AxiosRequestConfig = {
    method: (init.method ?? 'GET') as string,
    url: path,
  };

  if (init.body !== undefined) {
    if (isFormData) {
      config.data = init.body;
      // Let axios set Content-Type with boundary for FormData
      config.headers = { 'Content-Type': undefined };
    } else if (typeof init.body === 'string') {
      // Try to parse JSON strings (from JSON.stringify callers);
      // fall back to the raw string if it isn't valid JSON.
      try {
        config.data = JSON.parse(init.body);
      } catch {
        config.data = init.body;
      }
    } else {
      config.data = init.body;
    }
  }

  if (init.headers) {
    const extraHeaders: Record<string, string> = {};
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        extraHeaders[key] = value;
      });
    } else if (Array.isArray(init.headers)) {
      init.headers.forEach(([key, value]) => {
        extraHeaders[key] = value;
      });
    } else {
      Object.assign(extraHeaders, init.headers);
    }
    config.headers = { ...config.headers, ...extraHeaders };
  }

  const response = await instance.request<T>(config);
  // axios returns undefined data for 204 No Content
  return response.data;
}

/**
 * Blob variant of apiClient — for document/attachment downloads and previews.
 *
 * Every real download call site used to hit `fetch()` directly with a
 * snapshotted accessToken instead of going through this file's `instance`,
 * which meant two bugs at once (audit 2026-07-26 #7/#14):
 *   1. fetch() never rejects on a non-2xx status — an expired-token 401 or a
 *      backend 500 was blob-ified and force-downloaded as if it were the
 *      real file, with no error surfaced to the user.
 *   2. None of those call sites got the single-retry-after-refresh behavior
 *      the response interceptor above provides — a token that expired while
 *      a document page was left open produced a bare failure instead of a
 *      transparent refresh-and-retry.
 * Routing through `instance` fixes both: axios rejects on non-2xx by
 * default, and the same interceptors apply.
 */
/** Like apiClientBlob, but also exposes response headers (e.g. to read a
 *  server-supplied Content-Disposition filename) instead of just the blob. */
export async function apiClientBlobResponse(path: string, init: RequestInit = {}) {
  const config: AxiosRequestConfig = {
    method: (init.method ?? 'GET') as string,
    url: path,
    responseType: 'blob',
  };
  // FIX: this used to silently drop init.body — every caller so far has been
  // a bodyless GET so the bug was latent, but a POST-with-JSON-body blob
  // endpoint (e.g. form-template PDF preview) would have sent an empty body.
  // Mirrors apiClient()'s own body handling above.
  if (init.body !== undefined) {
    if (typeof FormData !== 'undefined' && init.body instanceof FormData) {
      config.data = init.body;
      config.headers = { 'Content-Type': undefined };
    } else if (typeof init.body === 'string') {
      try {
        config.data = JSON.parse(init.body);
      } catch {
        config.data = init.body;
      }
    } else {
      config.data = init.body;
    }
  }
  return instance.request<Blob>(config);
}

export async function apiClientBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  const response = await apiClientBlobResponse(path, init);
  return response.data;
}
