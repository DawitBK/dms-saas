"use client";

import React from 'react';
import { LucideIcon, Plus } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
    icon?: LucideIcon;
  };
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className = '' }: EmptyStateProps) {
  const ActionIcon = action?.icon ?? Plus;

  return (
    <div className={`ui-empty ${className}`}>
      <div
        className="flex items-center justify-center rounded-xl mb-4"
        style={{ width: 52, height: 52, background: 'var(--surface-raised)', border: '1px solid var(--border)' }}
      >
        <Icon className="h-6 w-6" style={{ color: 'var(--text-muted)' }} />
      </div>
      <p className="ui-empty-title">{title}</p>
      {description && <p className="ui-empty-desc">{description}</p>}
      {action && (
        <button onClick={action.onClick} className="ui-btn ui-btn-primary mt-2">
          <ActionIcon className="h-3.5 w-3.5" />
          {action.label}
        </button>
      )}
    </div>
  );
}
