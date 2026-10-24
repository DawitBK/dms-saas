'use client';

import { useState } from 'react';

/**
 * Run `reset` during render whenever any of `deps` changes, instead of in an
 * effect.
 *
 * This is React's documented "adjusting state when a prop changes" pattern
 * (react.dev/reference/react/useState#storing-information-from-previous-renders)
 * factored into one place, because this frontend needed it in a dozen
 * components — almost always to send a paginated list back to page 1 when its
 * filters, folder or department changed.
 *
 * Why not an effect. Two reasons, and the first is the one users notice:
 *
 *  1. An effect runs AFTER the browser has painted, so the list rendered once
 *     at the old page number against the new filters before correcting itself.
 *     With a page-4 cursor and a filter change that leaves only two pages of
 *     results, that first frame is an empty table. Adjusting during render
 *     means React discards the in-progress output and re-renders before
 *     anything reaches the screen.
 *  2. react-hooks/set-state-in-effect, an error under eslint-config-next 16,
 *     rejects the effect form outright.
 *
 * Semantics deliberately match a `useEffect` dependency array: `deps` are
 * compared element-wise with Object.is, exactly as React compares effect deps,
 * so moving a call from one to the other does not change WHEN it fires. The
 * single difference is that this does not fire on the first render — an effect
 * does. Every use here resets state to the value it was already initialised
 * with, so that first run was a no-op and skipping it removes a wasted render.
 * If you need mount behaviour, you need an effect, not this.
 *
 * IMPORTANT: every entry in `deps` must have a stable identity across renders.
 * A value rebuilt each render (a `.filter()` result, a `?? []` fallback, a
 * closure from a hook that does not memoise) never compares equal, and because
 * this sets state during render that is an immediate "Too many re-renders"
 * crash rather than the background churn the equivalent useEffect bug caused.
 * Pass a primitive where you can.
 *
 * This file is kept byte-identical in the DMS and GMS frontends (shared/hooks/
 * useResetOnChange.ts in each); the DMS copy carries the unit tests pinning the behaviour
 * above (the GMS frontend has no test runner). Change both together.
 */
export function useResetOnChange(deps: readonly unknown[], reset: () => void): void {
  const [previous, setPrevious] = useState(deps);
  const changed =
    previous.length !== deps.length || deps.some((dep, i) => !Object.is(dep, previous[i]));
  if (changed) {
    setPrevious(deps);
    reset();
  }
}
