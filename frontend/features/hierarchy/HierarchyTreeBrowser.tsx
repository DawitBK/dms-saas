"use client";

import React, { useState, useEffect, useCallback } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Building2,
  Landmark,
  Folder,
  Plus,
  MoreVertical,
  Edit2,
  Trash2,
  Shield,
  Network,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useHierarchyStore } from '@/state/hierarchy.store';
import { apiClient } from '@/shared/lib/apiClient';
import { usePermissions } from '@/shared/hooks/usePermissions';
import { PERMISSIONS } from '@/shared/lib/permissions';
import { HierarchyBreadcrumb } from '@/shared/components/HierarchyBreadcrumb';
import { moduleTreeCache, isTreeCacheFresh } from '@/shared/lib/hierarchyTreeCache';

type NodeType = 'tenant' | 'orgUnit' | 'department' | 'folder';

// The synthetic tenant root has this fixed id (it is not a DB row — it groups
// all org units under the tenant so the tree reads tenant → org unit → dept → folder).
// Exported so callers driving `selectedId` (e.g. the Browse page) can point back at it.
export const TENANT_ROOT_ID = '__tenant_root__';

// Perf audit 2026-08-13: this component previously refetched the entire
// org-unit/department/folder tree from a blank slate on every mount —
// meaning every time a user navigated away from Browse/Operations and back,
// every previously-expanded branch was re-fetched over the network from
// zero, even though nothing had changed. This module-level (not component-
// state) cache survives a remount within the same page load, so a remount
// within TTL seeds local state instantly instead of re-fetching. TTL
// matches the backend's own listReadableFolders cache
// (infrastructure/cache/readableFoldersCache.ts) for a consistent staleness
// budget across the stack. Mutation-triggered refreshes (create/rename/
// delete) still hit the network exactly as before — this only short-
// circuits the "nothing changed, I just navigated away and back" case.
//
// Cache state + reset live in shared/lib/hierarchyTreeCache.ts, not here —
// auth.store.ts's clearSession() resets it on every sign-out (platform audit
// finding 2026-08-14: this cache used to survive sign-out, briefly leaking a
// prior user's org-unit/department/folder tree to whoever logs in next on
// the same tab). See that file for the full explanation.

// Org-unit kinds (sister companies within one tenant: HQ, branches, outlets…).
const UNIT_TYPE_LABELS: Record<string, string> = {
  HQ: 'HQ',
  BRANCH: 'Branch',
  OUTLET: 'Outlet',
  SISTER_COMPANY: 'Sister Co.',
};

export interface TreeNode {
  id: string;
  name: string;
  type: NodeType;
  code?: string | null;
  unitType?: string | null;
  parentId?: string | null;
  departmentId?: string | null;
  orgUnitId?: string | null;
  childCount?: number;
  isExpanded?: boolean;
  children?: TreeNode[];
}

interface HierarchyTreeBrowserProps {
  onNodeSelect?: (node: TreeNode) => void;
  mode?: 'browse' | 'select';
  /** Display name for the tenant root (defaults to "Tenant"). */
  tenantName?: string;
  /** Compact chrome for embedding in a narrow sidebar (hides header + breadcrumb). */
  compact?: boolean;
  /**
   * Externally-controlled selected node id, for callers that drive their own
   * main pane off a different id source (e.g. the Browse page's folder-query
   * `currentId`) and need the tree's highlight to follow it — pass
   * `TENANT_ROOT_ID` to show the tree as "connected to root". Omit entirely
   * to let the tree manage selection purely from clicks inside itself (the
   * Operations Hierarchy Browser usage).
   */
  selectedId?: string;
  /**
   * Narrow the org-unit/department layer to what the viewer actually belongs
   * to or holds an explicit ACL grant on (`?scope=mine` on GET /org-units and
   * GET /departments/tree — see departments.service.ts's
   * getVisibleDepartmentIds for exactly what that means). ACL_BYPASS_ADMIN
   * holders always see everything regardless of this prop; the backend, not
   * this component, makes that call.
   *
   * Default false so the Operations "Hierarchy Browser" full-CRUD usage is
   * unaffected — an admin configuring the org structure needs to see every
   * org unit/department to attach a new one under it. Set true only for a
   * read/navigation surface like the Browse page sidebar, where a plain
   * employee should not be able to see (let alone click into, and hit a
   * "No access control entry" wall on) every department in the tenant.
   */
  scopeToViewer?: boolean;
}

// Dialogs are keyed by "kind" since each creates a different shape of record
// (an org unit needs code+name+type, a department needs code+name, a folder
// and a rename only need a name). Org units never nest — they're flat
// siblings under the tenant, the same way sister companies sit alongside
// each other rather than inside one another — so 'org-unit-create' has no
// parentUnitId (unlike department-create/folder-create, which do nest).
type DialogState =
  | { kind: 'org-unit-create'; code: string; name: string; unitType: 'HQ' | 'BRANCH' | 'OUTLET' | 'SISTER_COMPANY' }
  | { kind: 'department-create'; orgUnitId: string; parentId: string | null; code: string; name: string }
  | { kind: 'folder-create'; parentId: string; departmentId: string | null; name: string; refreshDepartmentId?: string }
  | { kind: 'rename'; node: TreeNode; name: string };

// Hoisted to module scope. It closes over nothing in the component, and while
// it was declared inside it, `loadOrgUnits` above referenced it before its own
// declaration — which react-hooks/immutability reports, because a value read
// before it is declared cannot pick up later changes to it.
function buildTree(items: any[], type: NodeType): TreeNode[] {
  const map = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  items.forEach(item => {
    map.set(item.id, {
      id: item.id,
      name: item.name,
      type,
      code: item.code ?? null,
      unitType: item.unitType ?? null,
      parentId: item.parentId,
      departmentId: item.departmentId,
      orgUnitId: item.orgUnitId,
      children: []
    });
  });

  items.forEach(item => {
    const node = map.get(item.id)!;
    if (item.parentId && map.has(item.parentId)) {
      map.get(item.parentId)!.children!.push(node);
    } else {
      roots.push(node);
    }
  });

  return roots;
}

/**
 * FIX 2026-09-23: GET /departments/tree returns an ALREADY-NESTED tree
 * (departments.service.ts's listDepartmentTree recursively builds each
 * department's own `children` array server-side) — unlike buildTree()
 * above, which is for a FLAT list with parentId links (org units, one
 * folder level at a time) and reconstructs nesting itself. Feeding
 * buildTree() the department response worked by accident for every
 * tenant until today: with no sub-departments anywhere, the top-level
 * `data` array WAS the whole flat list, one entry per (parentless)
 * department. The instant a department gained a child (SFE under IT,
 * created today — the first nested department this system has ever had),
 * buildTree() silently dropped it: `items.forEach` only walks the
 * TOP-LEVEL array (just `[IT]`), so SFE — sitting inside IT's own
 * `children` field, not as a sibling top-level item — was never read, and
 * the node buildTree() constructs for IT always resets `children: []`
 * regardless of what the source item already had. This recurses into that
 * pre-existing `children` array instead of assuming a flat input.
 */
function buildDepartmentTree(items: any[], type: NodeType): TreeNode[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    type,
    code: item.code ?? null,
    unitType: item.unitType ?? null,
    parentId: item.parentId,
    departmentId: item.departmentId,
    orgUnitId: item.orgUnitId,
    children: item.children && item.children.length > 0 ? buildDepartmentTree(item.children, type) : [],
  }));
}

/** Every id in a tree, including nested descendants — used to auto-expand a
 *  `scopeToViewer` subtree in one shot (see loadDepartmentsForUnit below). */
function collectIds(nodes: TreeNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    ids.push(node.id);
    if (node.children && node.children.length > 0) ids.push(...collectIds(node.children));
  }
  return ids;
}

export function HierarchyTreeBrowser({ onNodeSelect, mode = 'browse', tenantName = 'Tenant', compact = false, selectedId, scopeToViewer = false }: HierarchyTreeBrowserProps) {
  const { canAny: canAnyPermission } = usePermissions();
  // Seed straight from the module cache in the state initialisers rather than
  // in a mount effect that setStates five times. Besides being what
  // react-hooks/set-state-in-effect asks for (an error under
  // eslint-config-next 16), it removes a whole render pass: a warm cache used
  // to paint the empty tree with a spinner and only then swap in the data.
  //
  // No hydration hazard. The cache only ever goes warm inside `loadOrgUnits`,
  // which runs in the browser, so it is always cold during SSR and always
  // cold again after a full page load. A warm cache therefore implies a
  // client-side navigation, where there is no server HTML to match.
  // A lazy state initialiser, not `useRef(...).current` — reading a ref during
  // render is itself a react-hooks/refs error. This is state that is computed
  // once on mount and never set again, which is exactly what a lazy
  // initialiser is for.
  const [cacheWasFresh] = useState(() => isTreeCacheFresh(scopeToViewer));
  const [orgUnits, setOrgUnits] = useState<TreeNode[]>(() =>
    cacheWasFresh ? (moduleTreeCache.orgUnits as TreeNode[]) : [],
  );
  const [departmentsByUnit, setDepartmentsByUnit] = useState<Map<string, TreeNode[]>>(() =>
    cacheWasFresh ? (moduleTreeCache.departmentsByUnit as Map<string, TreeNode[]>) : new Map(),
  );
  const [folders, setFolders] = useState<Map<string, TreeNode[]>>(() =>
    cacheWasFresh ? (moduleTreeCache.folders as Map<string, TreeNode[]>) : new Map(),
  );
  // Tenant root starts expanded so org units are visible immediately.
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set([TENANT_ROOT_ID]));
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null);
  const [loading, setLoading] = useState(!cacheWasFresh);
  const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set());
  // Bumped by every genuine top-of-tree refetch. The effect below is what
  // actually stamps the cache's staleness clock: `Date.now()` and writing to a
  // module-level object are both impure, so they belong in an effect and not
  // in the body of `loadOrgUnits` (react-hooks/purity + react-hooks/immutability).
  const [fullLoadCount, setFullLoadCount] = useState(0);

  const { setDepartment, setFolder } = useHierarchyStore();
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [deleteConfirmNode, setDeleteConfirmNode] = useState<TreeNode | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  useEffect(() => {
    if (fullLoadCount > 0) {
      moduleTreeCache.fetchedAt = Date.now();
      moduleTreeCache.scopedFetch = scopeToViewer;
    }
  }, [fullLoadCount, scopeToViewer]);

  // Keep the module cache's DATA in sync with every change (initial load,
  // branch expansion, or a mutation's refresh) — independent of `fetchedAt`,
  // which only loadOrgUnits touches (see below). This is what makes a
  // previously-expanded branch come back instantly (no spinner, no network
  // call) if the user re-expands it after a fresh-cache remount: the data's
  // already sitting in departmentsByUnit/folders, so toggleExpand's
  // `!departmentsByUnit.has(node.id)` / `!folders.has(node.id)` guards skip
  // the fetch entirely.
  useEffect(() => {
    moduleTreeCache.orgUnits = orgUnits;
    moduleTreeCache.departmentsByUnit = departmentsByUnit;
    moduleTreeCache.folders = folders;
  }, [orgUnits, departmentsByUnit, folders]);

  // Follow an externally-controlled selection (e.g. Browse page's current
  // folder). Undefined means "uncontrolled" — leave selection to internal
  // clicks only, so this never fires for the Operations page usage, which
  // doesn't pass selectedId at all.
  //
  // Adjusted during render rather than in an effect (React's documented
  // "adjusting state when a prop changes"). The effect version painted one
  // frame with the previous node still highlighted before correcting itself,
  // and react-hooks/set-state-in-effect rejects it under eslint-config-next 16.
  const [lastSelectedId, setLastSelectedId] = useState(selectedId);
  if (selectedId !== undefined && selectedId !== lastSelectedId) {
    setLastSelectedId(selectedId);
    setSelectedNode(selectedId);
    if (selectedId === TENANT_ROOT_ID) {
      setExpandedNodes((prev) => new Set(prev).add(TENANT_ROOT_ID));
    }
  }

  // Declared before fetchOrgUnits (which now calls it eagerly for a scoped
  // viewer, below) so that call sits after this function's own declaration
  // in source order — react-hooks/immutability flags a reference before
  // declaration even when the actual call only fires later, asynchronously.
  const loadDepartmentsForUnit = useCallback(
    async (orgUnitId: string) => {
      setLoadingNodes((prev) => new Set(prev).add(orgUnitId));
      try {
        const response = await apiClient<{ data: any[] }>(
          `/departments/tree?orgUnitId=${orgUnitId}${scopeToViewer ? '&scope=mine' : ''}`,
        );
        const deptTree = buildDepartmentTree(response.data || [], 'department');
        setDepartmentsByUnit((prev) => new Map(prev).set(orgUnitId, deptTree));
        // FIX 2026-09-23: a department that nests sub-departments (e.g. SFE
        // under IT) rendered with its own collapsed ">" arrow, so a scoped
        // viewer whose ENTIRE visible tree is just that one branch (already
        // narrowed server-side to what they can see — see the ACL_BYPASS_ADMIN
        // fix above) had to manually click into every level to find a
        // department they demonstrably have access to. `scopeToViewer` mode's
        // whole point is "this is a small, already-filtered, all-yours tree",
        // so auto-expand every department node it contains, not just the org
        // unit — non-scoped (Operations admin) mode is untouched and stays
        // click-to-expand, since its full org-wide tree can be large.
        if (scopeToViewer) {
          setExpandedNodes((prev) => new Set([...prev, ...collectIds(deptTree)]));
        }
      } catch (error) {
        console.error('Failed to load departments:', error);
        setOpError(error instanceof Error ? error.message : 'Failed to load departments');
      } finally {
        setLoadingNodes((prev) => {
          const next = new Set(prev);
          next.delete(orgUnitId);
          return next;
        });
      }
    },
    [scopeToViewer],
  );

  // The fetch itself, split from the spinner. It sets no state synchronously,
  // which is what lets the mount effect below call it: react-hooks/
  // set-state-in-effect (an error under eslint-config-next 16) rejects an
  // effect that reaches a synchronous setState, and it does not treat an
  // `await` as a boundary — only a genuine callback. Hence the promise chain
  // rather than async/await.
  const fetchOrgUnits = useCallback(
    () =>
      apiClient<{ data: any[] }>(scopeToViewer ? '/org-units?scope=mine' : '/org-units')
        .then((response) => {
          // Normalize parentUnitId -> parentId so the shared buildTree() works unchanged.
          const items = (response.data || []).map((u) => ({ ...u, parentId: u.parentUnitId }));
          const tree = buildTree(items, 'orgUnit');
          setOrgUnits(tree);
          // Reveal the tenant root so its org units show without an extra click.
          setExpandedNodes((prev) => new Set(prev).add(TENANT_ROOT_ID));
          // FIX 2026-09-23: same reasoning as loadDepartmentsForUnit's own fix
          // below — a scoped viewer's org-unit layer is already narrowed
          // server-side to what they belong to (typically just one), so
          // requiring a click on it before its departments even start
          // loading added a full round trip of latency to "show me what's
          // mine" for no benefit. Non-scoped (Operations admin) mode is
          // unaffected and stays click-to-expand.
          if (scopeToViewer) {
            setExpandedNodes((prev) => new Set([...prev, ...tree.map((u) => u.id)]));
            for (const unit of tree) void loadDepartmentsForUnit(unit.id);
          }
          // A genuine top-of-tree refetch just happened — reset the cache's
          // staleness clock. Branch-level refreshes (loadFolders etc.) don't
          // touch this; only a real full load counts as "fetched". The stamp
          // itself is written by the effect above; this only records that a
          // full load happened.
          setFullLoadCount((n) => n + 1);
        })
        .catch((error: unknown) => {
          console.error('Failed to load organizational units:', error);
          setOpError(error instanceof Error ? error.message : 'Failed to load organizational units');
        })
        .finally(() => setLoading(false)),
    [scopeToViewer, loadDepartmentsForUnit],
  );

  // What the mutation handlers call when they need the tree rebuilt: same
  // fetch, but with the spinner raised first. Safe from an event handler,
  // which is where all three of its callers live.
  const loadOrgUnits = useCallback(async () => {
    setLoading(true);
    await fetchOrgUnits();
  }, [fetchOrgUnits]);

  // The initial fetch, declared AFTER its loader so the effect closes over the
  // real function rather than reading it before its declaration — which is what
  // react-hooks/immutability was reporting, and a genuine staleness trap. A
  // warm cache seeded the state initialisers above, so there is nothing to
  // fetch in that case; `loading` already started false there too.
  useEffect(() => {
    if (cacheWasFresh) return;
    void fetchOrgUnits();
  }, [cacheWasFresh, fetchOrgUnits]);

  const loadFolders = async (departmentId: string) => {
    setLoadingNodes(prev => new Set(prev).add(departmentId));
    try {
      // The department itself IS the container folder (its own FolderNode,
      // auto-provisioned on department creation) — what belongs under the
      // department node in this tree is that folder's children, not the
      // container folder redisplayed as its own nested entry.
      const response = await apiClient<{ data: { folder: any; subfolders: any[] } }>(`/folders/department/${departmentId}`);
      const folderTree = buildTree(response.data.subfolders || [], 'folder');
      setFolders(prev => new Map(prev).set(departmentId, folderTree));
    } catch (error) {
      console.error('Failed to load folders:', error);
      setOpError(error instanceof Error ? error.message : 'Failed to load folders');
    } finally {
      setLoadingNodes(prev => {
        const next = new Set(prev);
        next.delete(departmentId);
        return next;
      });
    }
  };

  // Resolves the department's own bound folder id (auto-provisioning it if a
  // pre-existing department predates that fix) so a category folder can be
  // created directly under the department.
  const getDepartmentRootFolderId = async (departmentId: string): Promise<string> => {
    const response = await apiClient<{ data: { folder: { id: string } } }>(`/folders/department/${departmentId}`);
    return response.data.folder.id;
  };

  const loadFolderContents = async (folderId: string) => {
    setLoadingNodes(prev => new Set(prev).add(folderId));
    try {
      const response = await apiClient<{ data: { subfolders: any[] } }>(`/folders/${folderId}/contents`);
      const subfolders = response.data.subfolders || [];

      const subfoldersAsNodes: TreeNode[] = subfolders.map(sf => ({
        id: sf.id,
        name: sf.name,
        type: 'folder',
        parentId: folderId,
        departmentId: sf.departmentId,
        children: []
      }));

      setFolders(prev => {
        const newMap = new Map(prev);

        const updateNodeChildren = (nodes: TreeNode[]): TreeNode[] => {
          return nodes.map(node => {
            if (node.id === folderId) {
              return { ...node, children: subfoldersAsNodes };
            }
            if (node.children && node.children.length > 0) {
              return { ...node, children: updateNodeChildren(node.children) };
            }
            return node;
          });
        };

        newMap.forEach((folderList, deptId) => {
          newMap.set(deptId, updateNodeChildren(folderList));
        });

        return newMap;
      });
    } catch (error) {
      console.error('Failed to load folder contents:', error);
      setOpError(error instanceof Error ? error.message : 'Failed to load folder contents');
    } finally {
      setLoadingNodes(prev => {
        const next = new Set(prev);
        next.delete(folderId);
        return next;
      });
    }
  };


  const toggleExpand = async (node: TreeNode) => {
    const newExpanded = new Set(expandedNodes);

    if (expandedNodes.has(node.id)) {
      newExpanded.delete(node.id);
    } else {
      newExpanded.add(node.id);

      // Tenant root's children (org units) are already loaded — nothing to fetch.
      if (node.type === 'orgUnit' && !departmentsByUnit.has(node.id)) {
        await loadDepartmentsForUnit(node.id);
      }

      if (node.type === 'department' && !folders.has(node.id)) {
        await loadFolders(node.id);
      }

      if (node.type === 'folder' && (!node.children || node.children.length === 0)) {
        await loadFolderContents(node.id);
      }
    }

    setExpandedNodes(newExpanded);
  };

  const handleNodeClick = (node: TreeNode) => {
    setSelectedNode(node.id);

    if (node.type === 'department') {
      setDepartment(node.id, node.name);
    } else if (node.type === 'folder') {
      setFolder(node.id, node.name);
    }

    onNodeSelect?.(node);
  };

  const handleContextMenu = (e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  };

  const handleContextMenuAction = async (
    action: 'create-dept' | 'create-sub' | 'create-folder' | 'rename' | 'manage-access' | 'delete',
    node: TreeNode,
  ) => {
    setOpError(null);
    if (action === 'manage-access') {
      router.push(`/operations?panel=accessControl&resource=${node.type}&id=${node.id}`);
      return;
    }
    if (action === 'create-dept' && node.type === 'orgUnit') {
      setDialog({ kind: 'department-create', orgUnitId: node.id, parentId: null, code: '', name: '' });
    } else if (action === 'create-sub' && node.type === 'department') {
      setDialog({ kind: 'department-create', orgUnitId: node.orgUnitId ?? '', parentId: node.id, code: '', name: '' });
    } else if (action === 'create-folder' && node.type === 'department') {
      try {
        const rootFolderId = await getDepartmentRootFolderId(node.id);
        setDialog({ kind: 'folder-create', parentId: rootFolderId, departmentId: node.id, name: '', refreshDepartmentId: node.id });
      } catch (err) {
        setOpError((err as Error)?.message ?? 'Failed to resolve the department folder');
      }
    } else if (action === 'create-sub' && node.type === 'folder') {
      setDialog({ kind: 'folder-create', parentId: node.id, departmentId: node.departmentId ?? null, name: '' });
    } else if (action === 'rename') {
      setDialog({ kind: 'rename', node, name: node.name });
    } else if (action === 'delete') {
      setDeleteConfirmNode(node);
    }
  };

  const handleDialogSubmit = async () => {
    if (!dialog) return;
    try {
      if (dialog.kind === 'org-unit-create') {
        if (!dialog.code.trim() || !dialog.name.trim()) { setOpError('Code and name are required'); return; }
        setDialog(null);
        await apiClient('/org-units', {
          method: 'POST',
          body: JSON.stringify({
            code: dialog.code.trim().toUpperCase(),
            name: dialog.name.trim(),
            unitType: dialog.unitType,
          }),
        });
        await loadOrgUnits();
      } else if (dialog.kind === 'department-create') {
        if (!dialog.code.trim() || !dialog.name.trim()) { setOpError('Code and name are required'); return; }
        setDialog(null);
        await apiClient('/departments', {
          method: 'POST',
          body: JSON.stringify({
            orgUnitId: dialog.orgUnitId,
            code: dialog.code.trim().toUpperCase(),
            name: dialog.name.trim(),
            parentId: dialog.parentId ?? undefined,
          }),
        });
        await loadDepartmentsForUnit(dialog.orgUnitId);
        setExpandedNodes(prev => new Set(prev).add(dialog.parentId ?? dialog.orgUnitId));
      } else if (dialog.kind === 'folder-create') {
        if (!dialog.name.trim()) { setOpError('Name cannot be empty'); return; }
        setDialog(null);
        await apiClient('/folders', {
          method: 'POST',
          body: JSON.stringify({ name: dialog.name.trim(), parentId: dialog.parentId, departmentId: dialog.departmentId }),
        });
        if (dialog.refreshDepartmentId) {
          // Created directly under the department's own (unrendered) container
          // folder — refresh that department's child list instead of looking
          // for a tree node keyed by the container folder's id.
          await loadFolders(dialog.refreshDepartmentId);
          setExpandedNodes(prev => new Set(prev).add(dialog.refreshDepartmentId!));
        } else {
          await loadFolderContents(dialog.parentId);
          setExpandedNodes(prev => new Set(prev).add(dialog.parentId));
        }
      } else if (dialog.kind === 'rename') {
        const trimmed = dialog.name.trim();
        if (!trimmed) { setOpError('Name cannot be empty'); return; }
        const { node } = dialog;
        setDialog(null);
        if (node.type === 'orgUnit') {
          await apiClient(`/org-units/${node.id}`, { method: 'PATCH', body: JSON.stringify({ name: trimmed }) });
          await loadOrgUnits();
        } else if (node.type === 'department') {
          await apiClient(`/departments/${node.id}`, { method: 'PATCH', body: JSON.stringify({ name: trimmed }) });
          if (node.orgUnitId) await loadDepartmentsForUnit(node.orgUnitId);
        } else if (node.departmentId) {
          await apiClient(`/folders/${node.id}`, { method: 'PATCH', body: JSON.stringify({ name: trimmed }) });
          // Root-level folder: refresh that department's folder list. A
          // renamed nested subfolder won't refresh its label until its
          // parent folder is re-expanded — same limitation this had before.
          await loadFolders(node.departmentId);
        }
      }
    } catch (err) {
      setOpError((err as Error)?.message ?? 'Operation failed');
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirmNode) return;
    const node = deleteConfirmNode;
    setDeleteConfirmNode(null);
    try {
      if (node.type === 'orgUnit') {
        await apiClient(`/org-units/${node.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: false }) });
        await loadOrgUnits();
      } else if (node.type === 'department') {
        await apiClient(`/departments/${node.id}`, { method: 'DELETE' });
        if (node.orgUnitId) await loadDepartmentsForUnit(node.orgUnitId);
      } else if (node.departmentId) {
        await apiClient(`/folders/${node.id}`, { method: 'DELETE' });
        await loadFolders(node.departmentId);
      }
    } catch (err) {
      setOpError((err as Error)?.message ?? 'Delete failed');
    }
  };

  const renderNode = (node: TreeNode, depth: number = 0): React.ReactNode => {
    const isExpanded = expandedNodes.has(node.id);
    const isSelected = selectedNode === node.id;
    const isNodeLoading = loadingNodes.has(node.id);
    // Before the first fetch we don't know yet whether a node has children, so
    // show the chevron optimistically (clicking it fetches and finds out).
    // Once fetched, hasChildren must reflect the ACTUAL count — otherwise the
    // chevron disappears the instant a node is expanded (departmentsByUnit /
    // folders now `.has()` the id regardless of how many came back), leaving
    // an expanded node with no way to click it closed again.
    const hasChildren = (node.children && node.children.length > 0) ||
      (node.type === 'tenant' && orgUnits.length > 0) ||
      (node.type === 'orgUnit' && (!departmentsByUnit.has(node.id) || (departmentsByUnit.get(node.id)?.length ?? 0) > 0)) ||
      (node.type === 'department' && (!folders.has(node.id) || (folders.get(node.id)?.length ?? 0) > 0));

    return (
      <div key={node.id}>
        <div
          className={`
            flex items-center px-2 py-1.5 rounded cursor-pointer
            hover:bg-gray-100 dark:hover:bg-gray-800
            ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : ''}
          `}
          style={{ paddingLeft: `${depth * (compact ? 0.9 : 1.5) + 0.5}rem` }}
          role="button"
          tabIndex={0}
          onClick={() => handleNodeClick(node)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleNodeClick(node); } }}
          onContextMenu={(e) => handleContextMenu(e, node)}
        >
          <div className="flex items-center space-x-1 flex-1 min-w-0">
            {hasChildren && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(node);
                }}
                className="p-0.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded shrink-0"
                disabled={isNodeLoading}
              >
                {isNodeLoading ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-gray-300 border-t-blue-600" />
                ) : isExpanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </button>
            )}

            {!hasChildren && <div className="w-5 shrink-0" />}

            <span className="shrink-0">
              {node.type === 'tenant' ? (
                <Network className="h-4 w-4 text-purple-500" />
              ) : node.type === 'orgUnit' ? (
                <Landmark className="h-4 w-4 text-indigo-500" />
              ) : node.type === 'department' ? (
                <Building2 className="h-4 w-4 text-blue-500" />
              ) : (
                <Folder className="h-4 w-4 text-yellow-500" />
              )}
            </span>

            {/* truncate (not wrap) long names so the badge/code after it never
                get pushed past the container's edge in the narrow compact sidebar */}
            <span
              className={`text-sm truncate min-w-0 ${node.type === 'tenant' ? 'font-bold' : 'font-medium'}`}
              title={node.name}
            >
              {node.name}
            </span>
            {node.type === 'orgUnit' && node.unitType && (
              <span className="shrink-0 whitespace-nowrap text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-500">
                {UNIT_TYPE_LABELS[node.unitType] ?? node.unitType}
              </span>
            )}
            {node.code && !compact && (
              <span className="shrink-0 whitespace-nowrap text-[10px] font-mono text-gray-400">{node.code}</span>
            )}
          </div>

          {/* The synthetic tenant root has no CRUD actions. */}
          {mode === 'browse' && node.type !== 'tenant' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleContextMenu(e, node);
              }}
              className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          )}
        </div>

        {isExpanded && node.type === 'tenant' && orgUnits.map(child => renderNode(child, depth + 1))}
        {isExpanded && node.children && node.children.map(child => renderNode(child, depth + 1))}
        {isExpanded && node.type === 'orgUnit' && departmentsByUnit.has(node.id) &&
          departmentsByUnit.get(node.id)!.map(child => renderNode(child, depth + 1))}
        {isExpanded && node.type === 'department' && folders.has(node.id) &&
          folders.get(node.id)!.map(child => renderNode(child, depth + 1))}
      </div>
    );
  };

  // Synthetic root so the tree literally reads tenant → org unit → dept → folder.
  const tenantRoot: TreeNode = { id: TENANT_ROOT_ID, name: tenantName, type: 'tenant' };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className={compact ? 'flex flex-col' : 'bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 h-full overflow-hidden flex flex-col'}>
      {!compact && (
        <div className="border-b border-gray-200 dark:border-gray-700 px-4 py-3">
          <HierarchyBreadcrumb />
        </div>
      )}

      <div className={compact ? 'flex-1 overflow-auto' : 'p-4 flex-1 overflow-auto'}>
        {!compact && (
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Organization Structure
            </h3>
            {/* Creating an organisation unit is organisation-level; the API refuses it for anyone else. */}
            {mode === 'browse' && canAnyPermission([PERMISSIONS.ACL_BYPASS_ADMIN, PERMISSIONS.ORG_UNIT_MANAGE]) && (
              <button
                onClick={() => setDialog({ kind: 'org-unit-create', code: '', name: '', unitType: 'HQ' })}
                className="flex items-center space-x-1 px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded"
              >
                <Plus className="h-4 w-4" />
                <span>New Org Unit</span>
              </button>
            )}
          </div>
        )}

        <div className="space-y-0.5">
          {renderNode(tenantRoot)}
          {orgUnits.length === 0 && (
            <div className="pl-6 py-3">
              <p className="text-gray-500 dark:text-gray-500 text-xs">
                No organizational units yet.
              </p>
              {mode === 'browse' && (
                <button
                  onClick={() => setDialog({ kind: 'org-unit-create', code: '', name: '', unitType: 'HQ' })}
                  className="mt-2 flex items-center space-x-1 px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded"
                >
                  <Plus className="h-4 w-4" />
                  <span>Add HQ / branch / sister company</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          node={contextMenu.node}
          onClose={() => setContextMenu(null)}
          onAction={handleContextMenuAction}
        />
      )}

      {opError && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-red-600 text-white px-4 py-2 rounded shadow-lg z-50 text-sm flex items-center space-x-2">
          <span>{opError}</span>
          <button onClick={() => setOpError(null)} className="font-bold leading-none">×</button>
        </div>
      )}

      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 w-80">
            <h2 className="text-base font-semibold mb-3 text-gray-900 dark:text-white">
              {dialog.kind === 'org-unit-create' && 'New Organizational Unit'}
              {dialog.kind === 'department-create' && (dialog.parentId ? 'New Sub-Department' : 'New Department')}
              {dialog.kind === 'folder-create' && 'New Sub-Folder'}
              {dialog.kind === 'rename' && `Rename "${dialog.node.name}"`}
            </h2>

            {(dialog.kind === 'org-unit-create' || dialog.kind === 'department-create') && (
              <input
                autoFocus
                type="text"
                className="w-full border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2 font-mono uppercase"
                placeholder="Code (e.g. HQ, FIN)"
                value={dialog.code}
                onChange={e => setDialog(d => d && (d.kind === 'org-unit-create' || d.kind === 'department-create') ? { ...d, code: e.target.value.toUpperCase() } : d)}
              />
            )}

            {dialog.kind === 'org-unit-create' && (
              <select
                className="w-full border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2"
                value={dialog.unitType}
                onChange={e => setDialog(d => d && d.kind === 'org-unit-create' ? { ...d, unitType: e.target.value as any } : d)}
              >
                <option value="HQ">Headquarters</option>
                <option value="BRANCH">Branch</option>
                <option value="OUTLET">Outlet</option>
                <option value="SISTER_COMPANY">Sister Company</option>
              </select>
            )}

            <input
              autoFocus={dialog.kind === 'folder-create' || dialog.kind === 'rename'}
              type="text"
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Name"
              value={dialog.name}
              onChange={e => setDialog(d => d ? { ...d, name: e.target.value } : d)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleDialogSubmit();
                if (e.key === 'Escape') setDialog(null);
              }}
            />

            <div className="mt-4 flex justify-end space-x-2">
              <button
                onClick={() => setDialog(null)}
                className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={handleDialogSubmit}
                className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
              >
                {dialog.kind === 'rename' ? 'Rename' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirmNode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 w-80">
            <h2 className="text-base font-semibold mb-2 text-gray-900 dark:text-white">
              {deleteConfirmNode.type === 'orgUnit' ? 'Deactivate Organizational Unit' : deleteConfirmNode.type === 'department' ? 'Deactivate Department' : 'Delete Folder'}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              {deleteConfirmNode.type === 'folder'
                ? `Delete "${deleteConfirmNode.name}"? This cannot be undone.`
                : `Deactivate "${deleteConfirmNode.name}"? It can be reactivated later, but active sub-items may block this.`}
            </p>
            <div className="flex justify-end space-x-2">
              <button
                onClick={() => setDeleteConfirmNode(null)}
                className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-700"
              >
                {deleteConfirmNode.type === 'folder' ? 'Delete' : 'Deactivate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface ContextMenuProps {
  x: number;
  y: number;
  node: TreeNode;
  onClose: () => void;
  onAction: (
    action: 'create-dept' | 'create-sub' | 'create-folder' | 'rename' | 'manage-access' | 'delete',
    node: TreeNode,
  ) => void;
}

function ContextMenu({ x, y, node, onClose, onAction }: ContextMenuProps) {
  // A top-level department is an organisation-level act; the API refuses it for a department head.
  const { canAny } = usePermissions();
  const canCreateTopLevelDepartment = canAny([PERMISSIONS.ACL_BYPASS_ADMIN, PERMISSIONS.ORG_UNIT_MANAGE]);
  useEffect(() => {
    const handleClick = () => onClose();
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [onClose]);

  const handleAction = (action: 'create-dept' | 'create-sub' | 'create-folder' | 'rename' | 'manage-access' | 'delete') => {
    onAction(action, node);
    onClose();
  };

  return (
    <div
      className="fixed z-50 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 min-w-[180px]"
      style={{ left: x, top: y }}
    >
      {/* Org units never nest — no "New Sub-Unit" here. Use the top-bar
          "New Org Unit" button to add another sibling under the tenant. */}
      {node.type === 'orgUnit' && canCreateTopLevelDepartment && (
        <button
          onClick={() => handleAction('create-dept')}
          className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center space-x-2"
        >
          <Plus className="h-4 w-4" />
          <span>New Department</span>
        </button>
      )}
      {node.type !== 'orgUnit' && (
        <button
          onClick={() => handleAction('create-sub')}
          className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center space-x-2"
        >
          <Plus className="h-4 w-4" />
          <span>New Sub-{node.type === 'department' ? 'Department' : 'Folder'}</span>
        </button>
      )}
      {node.type === 'department' && (
        <button
          onClick={() => handleAction('create-folder')}
          className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center space-x-2"
        >
          <Plus className="h-4 w-4" />
          <span>New Folder</span>
        </button>
      )}
      <button
        onClick={() => handleAction('rename')}
        className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center space-x-2"
      >
        <Edit2 className="h-4 w-4" />
        <span>Rename</span>
      </button>
      {node.type !== 'orgUnit' && (
        <button
          onClick={() => handleAction('manage-access')}
          className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center space-x-2"
        >
          <Shield className="h-4 w-4" />
          <span>Manage Access</span>
        </button>
      )}
      <hr className="my-1 border-gray-200 dark:border-gray-700" />
      <button
        onClick={() => handleAction('delete')}
        className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center space-x-2"
      >
        <Trash2 className="h-4 w-4" />
        <span>{node.type === 'folder' ? 'Delete' : 'Deactivate'}</span>
      </button>
    </div>
  );
}
