'use client';

import type { ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';

export type DragHandleProps = {
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
};

/**
 * One field's draggable slot in the form-builder canvas. Owns the actual
 * dnd-kit wiring (useSortable) and the grid-column span that makes the field
 * sit at its authored width, so FieldEditorRow itself stays a plain,
 * dnd-kit-agnostic component — only the render-prop's `dragHandleProps` need
 * to reach the actual grip icon, not the whole card, so clicking a text
 * input/select inside the card never accidentally starts a drag.
 */
export function SortableFieldCard({
  id,
  sectionId,
  widthSpan,
  children,
}: {
  id: string;
  /** Attached as sortable item data so FormCanvas's onDragEnd can tell a
   *  same-section reorder apart from a drag that strayed over a different
   *  section's drop area (which is deliberately a no-op — see FormCanvas). */
  sectionId: string;
  widthSpan: number;
  children: (drag: DragHandleProps, isDragging: boolean) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: { sectionId },
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        gridColumn: `span ${widthSpan} / span ${widthSpan}`,
        transform: CSS.Transform.toString(transform),
        transition: transition ?? undefined,
        opacity: isDragging ? 0.4 : 1,
        zIndex: isDragging ? 10 : undefined,
        position: 'relative',
      }}
    >
      {children({ attributes, listeners }, isDragging)}
    </div>
  );
}
