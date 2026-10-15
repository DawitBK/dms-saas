import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface HierarchyNode {
  id: string;
  name: string;
  type: 'tenant' | 'department' | 'folder';
}

interface HierarchyState {
  // Current selection
  tenantId: string | null;
  departmentId: string | null;
  folderId: string | null;
  
  // Breadcrumb path
  path: HierarchyNode[];
  
  // Actions
  setTenant: (id: string, name: string) => void;
  setDepartment: (id: string, name: string) => void;
  setFolder: (id: string, name: string) => void;
  navigateTo: (node: HierarchyNode) => void;
  reset: () => void;
  getBreadcrumbPath: () => HierarchyNode[];
}

const INITIAL_STATE = {
  tenantId: null,
  departmentId: null,
  folderId: null,
  path: []
};

export const useHierarchyStore = create<HierarchyState>()(
  persist(
    (set, get) => ({
      ...INITIAL_STATE,
      
      setTenant: (id: string, name: string) => {
        set({
          tenantId: id,
          departmentId: null,
          folderId: null,
          path: [{ id, name, type: 'tenant' }]
        });
      },
      
      setDepartment: (id: string, name: string) => {
        const state = get();
        if (!state.tenantId) {
          console.warn('Cannot set department without tenant');
          return;
        }
        
        const tenantNode = state.path[0];
        set({
          departmentId: id,
          folderId: null,
          path: tenantNode 
            ? [tenantNode, { id, name, type: 'department' }]
            : [{ id, name, type: 'department' }]
        });
      },
      
      setFolder: (id: string, name: string) => {
        const state = get();
        if (!state.departmentId) {
          console.warn('Cannot set folder without department');
          return;
        }
        
        const currentPath = state.path.filter(n => n.type !== 'folder');
        set({
          folderId: id,
          path: [...currentPath, { id, name, type: 'folder' }]
        });
      },
      
      navigateTo: (node: HierarchyNode) => {
        const state = get();
        
        if (node.type === 'tenant') {
          state.setTenant(node.id, node.name);
        } else if (node.type === 'department') {
          state.setDepartment(node.id, node.name);
        } else if (node.type === 'folder') {
          state.setFolder(node.id, node.name);
        }
      },
      
      reset: () => {
        set(INITIAL_STATE);
      },
      
      getBreadcrumbPath: () => {
        return get().path;
      }
    }),
    {
      name: 'hierarchy-context',
      version: 1
    }
  )
);
