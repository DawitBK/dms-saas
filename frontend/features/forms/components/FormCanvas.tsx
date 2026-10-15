'use client';

import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { BuilderField, SectionMeta } from '../schema';
import { UNSECTIONED_ID, LAYOUT_WIDTH_SPAN } from '../schema';
import { SortableFieldCard } from './SortableFieldCard';
import { FieldEditorRow } from './FieldEditorRow';

/**
 * The form builder's visual, editable canvas — replaces the old "flat list
 * grouped by section, with a separate read-only mini-strip approximating the
 * layout above it" design. What you see here IS the arrangement: fields
 * render at their real proportional width, side by side exactly where
 * they'll sit on the same row, and dragging a card reorders it directly —
 * both the vertical placement (which row) and horizontal placement (order
 * within the row, and how much of it a field takes) are edited in one place
 * instead of inferred from a list order + a separate width dropdown.
 *
 * No new data model needed for this: a field's row is already a pure
 * function of (list order within its section, layoutWidth) — see schema.ts's
 * layoutRows()/toSchema(). Dragging a card just reorders the underlying
 * `fields[]` array, the exact same lever the old ↑/↓ buttons used, just
 * directly manipulable instead of requiring the author to predict the
 * packing algorithm's result.
 *
 * Scope deliberately stops at reordering WITHIN a section — moving a field to
 * a DIFFERENT section is still done via its Section dropdown (FieldEditorRow),
 * not by dragging across section boundaries. Cross-container drag (Kanban-
 * style) is real added complexity dnd-kit supports, but a field's `section`
 * is a single property already reliably editable through a dropdown — adding
 * drag-driven reassignment on top would duplicate that capability for a
 * fairly small convenience gain, so it's left out.
 */
export function FormCanvas({
  fields,
  sections,
  onFieldsChange,
  onFieldChange,
  onFieldDelete,
  onAddField,
  onFieldFocus,
}: {
  fields: BuilderField[];
  sections: SectionMeta[];
  onFieldsChange: (next: BuilderField[]) => void;
  onFieldChange: (id: string, patch: Partial<BuilderField>) => void;
  onFieldDelete: (id: string) => void;
  onAddField: (section?: string) => void;
  /** Called when a field card is clicked/focused (not dragged) — lets the
   *  caller jump the live PDF preview to the page this field lands on. */
  onFieldFocus?: (field: BuilderField) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const bySection = useMemo(() => {
    const map = new Map<string, BuilderField[]>();
    for (const f of fields) {
      const key = f.section ?? UNSECTIONED_ID;
      map.set(key, [...(map.get(key) ?? []), f]);
    }
    return map;
  }, [fields]);

  const moveWithinSection = (fieldId: string, sectionId: string, targetIndex: number) => {
    const sectionFields = bySection.get(sectionId) ?? [];
    const fromIndex = sectionFields.findIndex((f) => f.id === fieldId);
    if (fromIndex === -1 || targetIndex === fromIndex) return;
    const reordered = arrayMove(sectionFields, fromIndex, targetIndex);
    // Rebuild the full list: every OTHER section's fields keep their exact
    // positions; this section's slice is spliced back in — at the index its
    // first field originally occupied — now in the new order.
    const firstIndexInFull = fields.findIndex((f) => (f.section ?? UNSECTIONED_ID) === sectionId);
    const otherFields = fields.filter((f) => (f.section ?? UNSECTIONED_ID) !== sectionId);
    const next = [...otherFields];
    next.splice(firstIndexInFull, 0, ...reordered);
    onFieldsChange(next);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeSectionId = active.data.current?.sectionId as string | undefined;
    const overSectionId = over.data.current?.sectionId as string | undefined;
    // A drag that ended over a different section's area is a no-op (see this
    // component's own doc comment on why cross-section drag isn't supported)
    // — dnd-kit will animate the card back to its start position.
    if (!activeSectionId || activeSectionId !== overSectionId) return;
    const sectionFields = bySection.get(activeSectionId) ?? [];
    const targetIndex = sectionFields.findIndex((f) => f.id === over.id);
    if (targetIndex === -1) return;
    moveWithinSection(String(active.id), activeSectionId, targetIndex);
  };

  const orderedSectionIds = [UNSECTIONED_ID, ...sections.map((s) => s.id)];

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <div className="space-y-5">
        {orderedSectionIds.map((sectionId) => {
          const sectionFields = bySection.get(sectionId) ?? [];
          if (sectionId === UNSECTIONED_ID && sectionFields.length === 0 && sections.length > 0) return null;
          const sectionMeta = sections.find((s) => s.id === sectionId);
          const sectionLabel = sectionMeta?.label ?? 'General';
          return (
            <div key={sectionId}>
              {sections.length > 0 && (
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)' }}>{sectionLabel}</p>
                  <button
                    onClick={() => onAddField(sectionId === UNSECTIONED_ID ? undefined : sectionId)}
                    className="ui-btn ui-btn-secondary !py-0.5 !px-1.5 text-[11px]"
                  >
                    <Plus size={11} /> Add field to this section
                  </button>
                </div>
              )}
              {sectionFields.length === 0 ? (
                <button
                  onClick={() => onAddField(sectionId === UNSECTIONED_ID ? undefined : sectionId)}
                  className="w-full rounded-lg border border-dashed p-4 text-xs text-center"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
                >
                  <Plus size={14} className="inline mr-1" /> Add the first field to this section
                </button>
              ) : (
                <SortableContext items={sectionFields.map((f) => f.id)} strategy={rectSortingStrategy}>
                  <div className="grid grid-cols-12 gap-3">
                    {sectionFields.map((field) => (
                      <SortableFieldCard
                        key={field.id}
                        id={field.id}
                        sectionId={sectionId}
                        widthSpan={LAYOUT_WIDTH_SPAN[field.layoutWidth ?? 'full']}
                      >
                        {(dragHandleProps, isDragging) => (
                          <FieldEditorRow
                            field={field}
                            allFields={fields}
                            sections={sections}
                            dragHandleProps={dragHandleProps}
                            isDragging={isDragging}
                            onChange={(patch) => onFieldChange(field.id, patch)}
                            onMove={(dir) => {
                              const sectionFieldIds = (bySection.get(sectionId) ?? []).map((f) => f.id);
                              const pos = sectionFieldIds.indexOf(field.id);
                              moveWithinSection(field.id, sectionId, pos + dir);
                            }}
                            onDelete={() => onFieldDelete(field.id)}
                            onFocusCard={() => onFieldFocus?.(field)}
                          />
                        )}
                      </SortableFieldCard>
                    ))}
                  </div>
                </SortableContext>
              )}
            </div>
          );
        })}
      </div>
    </DndContext>
  );
}
