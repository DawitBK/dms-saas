'use client';

import { useState } from 'react';
import { GripVertical, ArrowUp, ArrowDown, Trash2, Plus, X, ChevronDown, ChevronUp } from 'lucide-react';
import type { BuilderField, FieldType, LayoutWidth, SectionMeta } from '../schema';
import { FIELD_TYPE_LABELS, UNSECTIONED_ID, slug } from '../schema';
import type { DragHandleProps } from './SortableFieldCard';

const CONDITION_OPERATORS: { value: 'equals' | 'notEquals' | 'contains'; label: string }[] = [
  { value: 'equals', label: 'equals' },
  { value: 'notEquals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
];

const OPTIONS_TYPES: FieldType[] = ['select', 'radio'];
const VALIDATABLE_TEXT_TYPES: FieldType[] = ['text', 'textarea'];

// A compact segmented control replaces the old plain <select> for width —
// each option shows, in miniature, how much of a 12-column row it takes, so
// the effect is visible right where the choice is made instead of only in
// the live preview pane on the far side of the modal.
const WIDTH_OPTIONS: { value: LayoutWidth; label: string; hint: string }[] = [
  { value: 'full', label: 'Full', hint: 'Alone on its row' },
  { value: 'half', label: 'Half', hint: 'Pairs with one more field' },
  { value: 'third', label: '1/3', hint: 'Pairs with two more fields' },
  { value: 'quarter', label: '1/4', hint: 'Pairs with three more fields' },
];

export function FieldEditorRow({
  field,
  allFields,
  sections,
  dragHandleProps,
  isDragging,
  onChange,
  onMove,
  onDelete,
  onFocusCard,
}: {
  field: BuilderField;
  allFields: BuilderField[];
  sections: SectionMeta[];
  dragHandleProps: DragHandleProps;
  isDragging?: boolean;
  onChange: (patch: Partial<BuilderField>) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
  onFocusCard?: () => void;
}) {
  const otherFields = allFields.filter((f) => f.id !== field.id);
  const dateFields = otherFields.filter((f) => f.type === 'date');
  const hasOptions = OPTIONS_TYPES.includes(field.type);
  const hasTextValidation = VALIDATABLE_TEXT_TYPES.includes(field.type);
  const hasNumberValidation = field.type === 'number';
  const canBeComputed = field.type === 'number';
  const hasAdvancedContent = hasOptions || hasTextValidation || hasNumberValidation || canBeComputed || Boolean(field.conditionalOn) || otherFields.length > 0;

  // Collapsed by default so a plain text/date/number field — the overwhelming
  // majority — shows only what a first-time author needs (label, type,
  // width, required, section). Auto-expanded once a type that NEEDS more
  // setup is chosen (a dropdown/radio field is useless with no choices), so
  // the author isn't left hunting for a hidden panel at the exact moment
  // they need it.
  const [expanded, setExpanded] = useState(hasOptions);

  // onFocus here is a pure notification (React bubbles focus from any
  // descendant input/select through this handler), not a new interactive
  // affordance of the div itself — nothing about keyboard/mouse/touch
  // support changes, it just tells the parent "the user is now editing this
  // card" so the live preview can jump to the right page.
  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      onFocus={onFocusCard}
      className="rounded-lg border p-3 space-y-2 h-full"
      style={{
        borderColor: isDragging ? 'var(--brand-500)' : 'var(--border)',
        background: 'var(--surface-card)',
        boxShadow: isDragging ? '0 8px 24px rgba(0,0,0,0.15)' : undefined,
      }}
    >
      <div className="flex items-start gap-2">
        <button
          {...dragHandleProps.attributes}
          {...dragHandleProps.listeners}
          className="shrink-0 mt-5 cursor-grab active:cursor-grabbing touch-none"
          style={{ color: 'var(--text-muted)' }}
          aria-label="Drag to reorder this field"
          title="Drag to reorder — or use the up/down arrows"
        >
          <GripVertical size={16} />
        </button>

        <div className="flex-1 min-w-0 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--text-muted)' }}>
              Field label
            </label>
            <input
              className="ui-input w-full"
              placeholder="e.g. Full name"
              value={field.label}
              onChange={(e) => onChange({ label: e.target.value, name: slug(e.target.value) })}
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--text-muted)' }}>
              Type
            </label>
            <select
              className="ui-input w-full"
              value={field.type}
              onChange={(e) => onChange({ type: e.target.value as FieldType, options: undefined, validation: undefined, computed: undefined })}
            >
              {Object.entries(FIELD_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex gap-1">
            <button onClick={() => onMove(-1)} className="ui-btn-icon" title="Move earlier (same as dragging up)"><ArrowUp size={14} /></button>
            <button onClick={() => onMove(1)} className="ui-btn-icon" title="Move later (same as dragging down)"><ArrowDown size={14} /></button>
            <button onClick={onDelete} className="ui-btn-icon" title="Delete this field"><Trash2 size={14} /></button>
          </div>
        </div>
      </div>

      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)' }}>
          Row width — fields with matching widths sit side by side
        </label>
        <div className="inline-flex rounded-md border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
          {WIDTH_OPTIONS.map((opt, i) => {
            const active = (field.layoutWidth ?? 'full') === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onChange({ layoutWidth: opt.value })}
                title={opt.hint}
                className="px-2.5 py-1 text-[11px] font-semibold"
                style={{
                  borderLeft: i > 0 ? '1px solid var(--border)' : undefined,
                  background: active ? 'var(--brand-600)' : 'transparent',
                  color: active ? '#fff' : 'var(--text-secondary)',
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--text-muted)' }}>
            Section
          </label>
          <select
            className="ui-input !py-1 text-xs"
            value={field.section ?? UNSECTIONED_ID}
            onChange={(e) => onChange({ section: e.target.value === UNSECTIONED_ID ? undefined : e.target.value })}
          >
            <option value={UNSECTIONED_ID}>General</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-1.5 text-xs pb-1.5" style={{ color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={field.required} onChange={(e) => onChange({ required: e.target.checked })} /> Required
        </label>
        {hasAdvancedContent && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="ml-auto text-[11px] inline-flex items-center gap-1"
            style={{ color: 'var(--brand-600)' }}
          >
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {expanded ? 'Fewer settings' : 'More settings (choices, validation, conditions…)'}
          </button>
        )}
      </div>

      {expanded && (
        <div className="space-y-2 pt-1 border-t" style={{ borderColor: 'var(--border-subtle, var(--border))' }}>

      {hasOptions && (
        <div>
          <p className="text-[11px] font-bold uppercase mb-1" style={{ color: 'var(--text-muted)' }}>Choices</p>
          <div className="space-y-1">
            {(field.options ?? []).map((opt, i) => (
              <div key={i} className="flex gap-1">
                <input
                  className="ui-input flex-1"
                  value={opt}
                  onChange={(e) => {
                    const next = [...(field.options ?? [])];
                    next[i] = e.target.value;
                    onChange({ options: next });
                  }}
                />
                <button
                  className="ui-btn-icon"
                  onClick={() => onChange({ options: (field.options ?? []).filter((_, idx) => idx !== i) })}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            <button
              className="ui-btn ui-btn-secondary !py-1 !px-2 text-xs"
              onClick={() => onChange({ options: [...(field.options ?? []), `Option ${(field.options?.length ?? 0) + 1}`] })}
            >
              <Plus size={12} /> Add choice
            </button>
          </div>
        </div>
      )}

      {(hasTextValidation || hasNumberValidation) && (
        <div>
          <p className="text-[11px] font-bold uppercase mb-1" style={{ color: 'var(--text-muted)' }}>Validation</p>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {hasTextValidation && (
              <>
                <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  Min length
                  <input
                    type="number"
                    className="ui-input mt-0.5"
                    value={field.validation?.minLength ?? ''}
                    onChange={(e) => onChange({ validation: { ...field.validation, minLength: e.target.value ? Number(e.target.value) : undefined } })}
                  />
                </label>
                <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  Max length
                  <input
                    type="number"
                    className="ui-input mt-0.5"
                    value={field.validation?.maxLength ?? ''}
                    onChange={(e) => onChange({ validation: { ...field.validation, maxLength: e.target.value ? Number(e.target.value) : undefined } })}
                  />
                </label>
                <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  Regex pattern (advanced)
                  <input
                    className="ui-input mt-0.5"
                    placeholder="e.g. ^[0-9]{5}$"
                    value={field.validation?.pattern ?? ''}
                    onChange={(e) => onChange({ validation: { ...field.validation, pattern: e.target.value || undefined } })}
                  />
                </label>
              </>
            )}
            {hasNumberValidation && (
              <>
                <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  Min value
                  <input
                    type="number"
                    className="ui-input mt-0.5"
                    value={field.validation?.min ?? ''}
                    onChange={(e) => onChange({ validation: { ...field.validation, min: e.target.value ? Number(e.target.value) : undefined } })}
                  />
                </label>
                <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  Max value
                  <input
                    type="number"
                    className="ui-input mt-0.5"
                    value={field.validation?.max ?? ''}
                    onChange={(e) => onChange({ validation: { ...field.validation, max: e.target.value ? Number(e.target.value) : undefined } })}
                  />
                </label>
              </>
            )}
          </div>
        </div>
      )}

      {canBeComputed && (
        <div>
          <p className="text-[11px] font-bold uppercase mb-1" style={{ color: 'var(--text-muted)' }}>Compute from dates</p>
          {field.computed ? (
            dateFields.some((f) => f.name === field.computed!.fromField) && dateFields.some((f) => f.name === field.computed!.toField) ? (
              <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_auto_32px] items-center">
                <select
                  className="ui-input"
                  value={field.computed.fromField}
                  onChange={(e) => onChange({ computed: { ...field.computed!, fromField: e.target.value } })}
                >
                  {dateFields.map((f) => <option key={f.id} value={f.name}>From: {f.label}</option>)}
                </select>
                <select
                  className="ui-input"
                  value={field.computed.toField}
                  onChange={(e) => onChange({ computed: { ...field.computed!, toField: e.target.value } })}
                >
                  {dateFields.map((f) => <option key={f.id} value={f.name}>To: {f.label}</option>)}
                </select>
                <label className="flex items-center gap-1 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={Boolean(field.computed.inclusive)}
                    onChange={(e) => onChange({ computed: { ...field.computed!, inclusive: e.target.checked } })}
                  /> Count both dates
                </label>
                <button className="ui-btn-icon" onClick={() => onChange({ computed: undefined })} title="Stop computing — make this a normal number field"><X size={14} /></button>
              </div>
            ) : (
              <p className="text-xs" style={{ color: 'var(--color-red-400, #ef4444)' }}>
                Needs two date fields on this form to compute from — one was removed or changed type. Fix the selection or remove this.
                <button className="ui-btn ui-btn-secondary !py-1 !px-2 text-xs ml-2" onClick={() => onChange({ computed: undefined })}>Remove</button>
              </p>
            )
          ) : dateFields.length >= 2 ? (
            <button
              className="ui-btn ui-btn-secondary !py-1 !px-2 text-xs"
              onClick={() => onChange({ computed: { type: 'dateDiffDays', fromField: dateFields[0].name, toField: dateFields[1].name } })}
            >
              <Plus size={12} /> Auto-calculate from two date fields
            </button>
          ) : (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Add two Date fields first to compute a value from them (e.g. days between them).</p>
          )}
        </div>
      )}

      {otherFields.length > 0 && (
        <div>
          <p className="text-[11px] font-bold uppercase mb-1" style={{ color: 'var(--text-muted)' }}>Show this field only if</p>
          {field.conditionalOn ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_140px_1fr_32px] items-center">
              <select
                className="ui-input"
                value={field.conditionalOn.field}
                onChange={(e) => onChange({ conditionalOn: { ...field.conditionalOn!, field: e.target.value } })}
              >
                {otherFields.map((f) => <option key={f.id} value={f.name}>{f.label}</option>)}
              </select>
              <select
                className="ui-input"
                value={field.conditionalOn.operator}
                onChange={(e) => onChange({ conditionalOn: { ...field.conditionalOn!, operator: e.target.value as 'equals' | 'notEquals' | 'contains' } })}
              >
                {CONDITION_OPERATORS.map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}
              </select>
              <input
                className="ui-input"
                placeholder="Value"
                value={field.conditionalOn.value}
                onChange={(e) => onChange({ conditionalOn: { ...field.conditionalOn!, value: e.target.value } })}
              />
              <button className="ui-btn-icon" onClick={() => onChange({ conditionalOn: undefined })}><X size={14} /></button>
            </div>
          ) : (
            <button
              className="ui-btn ui-btn-secondary !py-1 !px-2 text-xs"
              onClick={() => onChange({ conditionalOn: { field: otherFields[0].name, operator: 'equals', value: '' } })}
            >
              <Plus size={12} /> Add condition
            </button>
          )}
          {field.required && field.conditionalOn && (
            <p className="mt-1 text-xs" style={{ color: 'var(--color-amber-500, #b45309)' }}>
              This field is required but only shown when the condition above is met — if that condition is rarely or
              never true, submitters may never be able to satisfy it. Double-check this is intended.
            </p>
          )}
        </div>
      )}
        </div>
      )}
    </div>
  );
}
