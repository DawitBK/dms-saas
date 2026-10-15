import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { useState } from 'react';
import { useResetOnChange } from './useResetOnChange';

// This hook adjusts state DURING render, and 29 call sites across the app rely
// on it behaving exactly like a useEffect dependency array minus the mount run.
// Two of those properties are load-bearing enough to pin down here:
//
//  - it must not fire on the first render (every caller resets state to the
//    value it was already initialised with, so a mount run is a wasted render);
//  - it must compare deps ELEMENT-WISE, not by array identity. A fresh array
//    literal is built on every render by definition, so identity comparison
//    would re-fire forever — and because this sets state during render, that is
//    an immediate "Too many re-renders" crash rather than background churn.
function Probe({ value, onReset }: { value: unknown; onReset: () => void }) {
  useResetOnChange([value], onReset);
  return null;
}

describe('useResetOnChange', () => {
  it('does not fire on the first render', () => {
    let calls = 0;
    render(<Probe value="a" onReset={() => { calls += 1; }} />);
    expect(calls).toBe(0);
  });

  it('fires once when a dep changes, and not on re-renders that keep it', () => {
    let calls = 0;
    const onReset = () => { calls += 1; };
    const { rerender } = render(<Probe value="a" onReset={onReset} />);

    rerender(<Probe value="b" onReset={onReset} />);
    expect(calls).toBe(1);

    // Same value, new array literal each render: element-wise comparison must
    // treat this as unchanged.
    rerender(<Probe value="b" onReset={onReset} />);
    rerender(<Probe value="b" onReset={onReset} />);
    expect(calls).toBe(1);

    rerender(<Probe value="c" onReset={onReset} />);
    expect(calls).toBe(2);
  });

  it('actually applies the state change before anything is committed', () => {
    // The point of adjusting during render rather than in an effect: the
    // corrected value is what gets rendered, never the stale one.
    const seen: number[] = [];
    function Paged({ filter }: { filter: string }) {
      const [page, setPage] = useState(4);
      useResetOnChange([filter], () => setPage(1));
      seen.push(page);
      return <span>{page}</span>;
    }
    const { rerender, container } = render(<Paged filter="x" />);
    expect(container.textContent).toBe('4');

    rerender(<Paged filter="y" />);
    // The committed output is the reset value, and 4 was never painted for
    // filter "y" — React discarded that in-progress render.
    expect(container.textContent).toBe('1');
  });

  it('crashes loudly on a dep whose identity changes every render', () => {
    // Pinned deliberately, because this is the one way to misuse the hook and
    // the failure has to stay loud. Passing a value rebuilt on every render
    // (a `.filter()` result, a fresh `[]` fallback, a closure from a hook that
    // does not memoise) means the key never compares equal, and because this
    // adjusts state during render React stops it at once rather than looping
    // in the background the way the equivalent useEffect bug did. That is why
    // usePermissions() memoises `can` and upload/page.tsx memoises
    // selectableDepartments — both were unstable, and both fed change keys.
    function Unstable() {
      useResetOnChange([{}], () => {});
      return null;
    }
    // Note it survives the FIRST render: `previous` is seeded from `deps`, so
    // nothing is compared until there is a second render to compare against.
    // That is exactly why this class of bug reaches production — the page
    // mounts fine and dies on the first state change.
    const consoleError = console.error;
    console.error = () => {}; // React logs the same failure it throws
    try {
      const { rerender } = render(<Unstable />);
      expect(() => rerender(<Unstable />)).toThrow(/Too many re-renders/);
    } finally {
      console.error = consoleError;
    }
  });
});
