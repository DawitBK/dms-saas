"use client";

import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';

interface ModalProps {
  isOpen?: boolean;
  open?: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  className?: string;
}

const sizeMap = {
  sm:  'max-w-sm',
  md:  'max-w-md',
  lg:  'max-w-lg',
  xl:  'max-w-xl',
  '2xl': 'max-w-2xl',
};

export function Modal({
  isOpen: isOpenProp,
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  className = '',
}: ModalProps) {
  const isOpen = isOpenProp ?? open ?? false;
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop. role="presentation" is accurate rather than a lint dodge:
          this layer is a mouse convenience, and both the header's Close button
          and the Escape handler above are the keyboard paths out. */}
      <div
        className="absolute inset-0 animate-fade-in"
        style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
        onClick={onClose}
        role="presentation"
      />

      {/* Panel. max-h + flex-col + a scrolling body, rather than letting the
          panel grow to whatever height its content needs: with no height
          cap, a form tall enough (this one, once its Departments picker grew
          an org-unit filter select) simply overflows the viewport with NO
          scrollbar at all -- worse than crudPanels.tsx's own Modal, which at
          least had overflow-y-auto (just not a sticky header). Header and
          footer stay put; only the body scrolls. */}
      <div
        ref={panelRef}
        className={cn(
          'relative w-full max-h-[90vh] flex flex-col animate-scale-in',
          sizeMap[size],
          className,
        )}
        style={{
          background: 'var(--surface-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-xl)',
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        {/* Header */}
        <div
          className="flex items-start justify-between px-6 py-4 shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex-1 min-w-0 pr-4">
            <h3
              id="modal-title"
              className="text-[15px] font-semibold leading-tight"
              style={{ color: 'var(--text-primary)', letterSpacing: '-0.01em' }}
            >
              {title}
            </h3>
            {description && (
              <p className="text-[13px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {description}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="ui-btn ui-btn-ghost ui-btn-icon shrink-0"
            aria-label="Close"
            style={{ marginTop: -4, marginRight: -8 }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 overflow-y-auto min-h-0">{children}</div>

        {/* Footer */}
        {footer && (
          <div
            className="flex items-center justify-end gap-2.5 px-6 py-4 shrink-0"
            style={{ borderTop: '1px solid var(--border)' }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

interface ModalFooterProps {
  onCancel: () => void;
  onConfirm: () => void;
  cancelText?: string;
  confirmText?: string;
  confirmDisabled?: boolean;
  confirmLoading?: boolean;
  confirmVariant?: 'primary' | 'danger' | 'success';
}

export function ModalFooter({
  onCancel,
  onConfirm,
  cancelText = 'Cancel',
  confirmText = 'Confirm',
  confirmDisabled = false,
  confirmLoading = false,
  confirmVariant = 'primary',
}: ModalFooterProps) {
  const confirmClass =
    confirmVariant === 'danger'
      ? 'ui-btn ui-btn-danger'
      : 'ui-btn ui-btn-primary';

  return (
    <>
      <button type="button" onClick={onCancel} className="ui-btn ui-btn-secondary">
        {cancelText}
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={confirmDisabled || confirmLoading}
        className={confirmClass}
      >
        {confirmLoading ? (
          <span className="flex items-center gap-2">
            <span
              className="inline-block h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin"
            />
            Loading…
          </span>
        ) : (
          confirmText
        )}
      </button>
    </>
  );
}
