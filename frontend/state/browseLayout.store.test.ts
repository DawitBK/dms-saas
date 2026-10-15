import { beforeEach, describe, expect, it } from 'vitest';
import {
  useBrowseLayoutStore,
  clampBrowseTreeWidth,
  BROWSE_TREE_DEFAULT_WIDTH,
  BROWSE_TREE_MAX_WIDTH,
  BROWSE_TREE_MIN_WIDTH,
} from './browseLayout.store';

describe('browse layout store', () => {
  beforeEach(() => {
    useBrowseLayoutStore.setState({ treeCollapsed: false, treeWidth: BROWSE_TREE_DEFAULT_WIDTH });
  });

  it('clamps width into the usable range and rejects garbage', () => {
    expect(clampBrowseTreeWidth(10)).toBe(BROWSE_TREE_MIN_WIDTH);
    expect(clampBrowseTreeWidth(99999)).toBe(BROWSE_TREE_MAX_WIDTH);
    expect(clampBrowseTreeWidth(Number.NaN)).toBe(BROWSE_TREE_DEFAULT_WIDTH);
    expect(clampBrowseTreeWidth(400.6)).toBe(401);
  });

  it('setTreeWidth always stores a clamped value', () => {
    useBrowseLayoutStore.getState().setTreeWidth(5);
    expect(useBrowseLayoutStore.getState().treeWidth).toBe(BROWSE_TREE_MIN_WIDTH);
  });

  it('toggles collapsed state', () => {
    useBrowseLayoutStore.getState().toggleTreeCollapsed();
    expect(useBrowseLayoutStore.getState().treeCollapsed).toBe(true);
    useBrowseLayoutStore.getState().toggleTreeCollapsed();
    expect(useBrowseLayoutStore.getState().treeCollapsed).toBe(false);
  });
});
