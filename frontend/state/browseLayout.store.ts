'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Bounds for the Browse page's folder-hierarchy panel, in CSS pixels. */
export const BROWSE_TREE_MIN_WIDTH = 240;
export const BROWSE_TREE_MAX_WIDTH = 640;
export const BROWSE_TREE_DEFAULT_WIDTH = 340;

export function clampBrowseTreeWidth(width: number): number {
  if (!Number.isFinite(width)) return BROWSE_TREE_DEFAULT_WIDTH;
  return Math.min(BROWSE_TREE_MAX_WIDTH, Math.max(BROWSE_TREE_MIN_WIDTH, Math.round(width)));
}

type BrowseLayoutState = {
  /** Folder-hierarchy panel folded away, leaving only an expand button. */
  treeCollapsed: boolean;
  treeWidth: number;
  setTreeCollapsed: (collapsed: boolean) => void;
  toggleTreeCollapsed: () => void;
  setTreeWidth: (width: number) => void;
};

export const useBrowseLayoutStore = create<BrowseLayoutState>()(
  persist(
    (set) => ({
      treeCollapsed: false,
      treeWidth: BROWSE_TREE_DEFAULT_WIDTH,
      setTreeCollapsed: (treeCollapsed) => set({ treeCollapsed }),
      toggleTreeCollapsed: () => set((s) => ({ treeCollapsed: !s.treeCollapsed })),
      setTreeWidth: (width) => set({ treeWidth: clampBrowseTreeWidth(width) }),
    }),
    {
      name: 'dms-browse-layout',
      // A hand-edited or stale value must never produce an unusable panel.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<BrowseLayoutState>;
        return {
          ...current,
          treeCollapsed: p.treeCollapsed === true,
          treeWidth: clampBrowseTreeWidth(p.treeWidth ?? BROWSE_TREE_DEFAULT_WIDTH),
        };
      },
    },
  ),
);
