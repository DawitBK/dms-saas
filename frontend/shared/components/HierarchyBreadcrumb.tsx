"use client";

import React from 'react';
import { useHierarchyStore } from '@/state/hierarchy.store';
import { ChevronRight, Building2, Folder, Globe } from 'lucide-react';

export function HierarchyBreadcrumb() {
  const { path, navigateTo } = useHierarchyStore();
  
  if (path.length === 0) {
    return null;
  }
  
  const getIcon = (type: string) => {
    switch (type) {
      case 'tenant':
        return <Globe className="h-4 w-4" />;
      case 'department':
        return <Building2 className="h-4 w-4" />;
      case 'folder':
        return <Folder className="h-4 w-4" />;
      default:
        return null;
    }
  };
  
  return (
    <nav className="flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-400 bg-white dark:bg-gray-800 px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700">
      {path.map((node, index) => (
        <React.Fragment key={node.id}>
          {index > 0 && (
            <ChevronRight className="h-4 w-4 text-gray-400" />
          )}
          <button
            onClick={() => navigateTo(node)}
            className="flex items-center space-x-1 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
          >
            {getIcon(node.type)}
            <span className="font-medium">{node.name}</span>
          </button>
        </React.Fragment>
      ))}
    </nav>
  );
}
