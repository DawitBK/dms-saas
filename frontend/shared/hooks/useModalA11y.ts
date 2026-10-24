import { useEffect } from 'react';

/**
 * audit 2026-07-26 #16: shared/components/Modal.tsx provides
 * Escape-to-close and scroll lock (plus role="dialog"/aria-modal, applied at
 * the call site) but the newest feature area's hand-rolled modals
 * (ApprovalChainCard, FillFormModal, TemplateBuilderModal) skip it entirely —
 * a bare `fixed inset-0` div with none of that, so keyboard users can't close
 * them without a mouse. This hook gives any custom modal markup the same two
 * behaviors without requiring a rewrite onto the shared <Modal> component;
 * pair it with role="dialog" aria-modal="true" aria-labelledby={...} on the
 * panel element itself.
 */
export function useModalA11y(isOpen: boolean, onClose: () => void) {
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, onClose]);
}
