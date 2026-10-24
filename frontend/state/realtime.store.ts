import { create } from 'zustand';

/**
 * Whether the realtime socket is currently connected.
 *
 * F-06 (audit 2026-09-03) asked why My Work polls when the app
 * already has WebSockets. It shouldn't have to — the socket pipeline
 * (RealtimeBridge + the transactional outbox behind it) already invalidates the
 * My Work queries, so the interval was redundant work on the system's hottest
 * endpoint, paid by every signed-in user regardless of whether anything had
 * changed.
 *
 * But a poll cannot simply be deleted either: a socket can be down without the
 * UI knowing why — a proxy that drops idle upgrades, a Redis outage taking the
 * socket.io adapter with it, a laptop resumed from sleep before socket.io has
 * finished reconnecting. Silently showing a stale, empty inbox to an approver
 * is worse than a redundant request.
 *
 * So the poll becomes a fallback rather than the mechanism: queries interested
 * in live data read `connected` here and only fall back to an interval while
 * the socket is actually down. Connected is the normal case, so the steady
 * state is zero polling and updates arrive as they happen.
 */
interface RealtimeState {
  connected: boolean;
  setConnected: (connected: boolean) => void;
}

export const useRealtimeStore = create<RealtimeState>((set) => ({
  // Starts false: until the socket says otherwise, assume it is not carrying
  // events. That way a page mounted before the handshake completes polls for a
  // moment rather than sitting silent, and the very first `connect` turns it
  // off. Failing toward "poll" is the safe direction.
  connected: false,
  setConnected: (connected) => set({ connected }),
}));

/**
 * How often to re-fetch live queries while the socket is down. Well under the
 * old unconditional 60s, because this now only runs in the degraded case where
 * it is the ONLY thing keeping the view fresh — and, unlike the old interval,
 * it stops entirely as soon as the socket is back.
 */
export const REALTIME_FALLBACK_POLL_MS = 20_000;

/**
 * `refetchInterval` for a query whose freshness the socket normally maintains.
 * Pass the store's `connected` value; returns false (no polling) when the
 * socket is live.
 */
export function fallbackPollInterval(connected: boolean): number | false {
  return connected ? false : REALTIME_FALLBACK_POLL_MS;
}
