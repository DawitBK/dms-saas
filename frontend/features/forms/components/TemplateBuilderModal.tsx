'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Upload, Building2, ChevronLeft, ChevronRight, ArrowUp, ArrowDown, Sparkles, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import type { BuilderField, FieldSchema, SectionMeta } from '../schema';
import { UNSECTIONED_ID, fromSchema, toSchema, slug } from '../schema';
import { FormCanvas } from './FormCanvas';
import { uploadFormBasePdf, previewFormTemplatePdf, getExampleCorpLetterheadObjectKey, listFormTemplateCategories, extractFormFieldsFromImage } from '../api';
import { useModalA11y } from '../../../shared/hooks/useModalA11y';
import { useResetOnChange } from '../../../shared/hooks/useResetOnChange';
import { usePermissions } from '../../../shared/hooks/usePermissions';
import { useMyDepartments } from '../../../shared/hooks/useMyDepartments';
import { ScopeSelect } from './ScopeSelect';
import { hasOrgLevelAuthority, initialScope, scopePayload, scopeProblem } from '../templateScope';

// PDF is the primary base file; images are accepted too (normalized to PNG
// and wrapped into a one-page PDF server-side — see forms.service.ts's
// wrapImageAsPdf) — any raster format sharp can decode works, not just
// PNG/JPEG. DOCX is deliberately not supported (would need an external
// conversion binary), so it gets a clear, specific rejection message instead
// of a generic one.
const ALLOWED_BASE_FILE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const BASE_FILE_ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp,image/gif';
const PREVIEW_DEBOUNCE_MS = 500;

// The subset of a saved FormTemplate needed to re-open it for editing —
// deliberately loose (not importing the full api.ts FormTemplate type) so
// this component doesn't care whether the caller passes a list-row object or
// a freshly-fetched one, as long as it carries these fields.
export type EditableTemplate = {
  id: string;
  name: string;
  category?: string | null;
  basePdfObjectKey?: string | null;
  isLetterhead?: boolean;
  schemaJson?: FieldSchema[][];
  sectionsJson?: SectionMeta[] | null;
  instanceApproval?: 'none' | 'chain';
  auditPolicy?: 'required' | 'optional' | 'never';
  signingPolicy?: 'none' | 'ceremony';
  /** Who can use the form; both null/absent = the whole organisation. */
  departmentId?: string | null;
  orgUnitId?: string | null;
};

type TemplateFormPayload = { name: string; category?: string; basePdfObjectKey?: string; isLetterhead?: boolean; schemaJson: object; sectionsJson: SectionMeta[]; instanceApproval?: 'none' | 'chain'; auditPolicy?: 'required' | 'optional' | 'never'; signingPolicy?: 'none' | 'ceremony'; departmentId?: string | null; orgUnitId?: string | null };

export function TemplateBuilderModal({
  onClose,
  onCreate,
  isCreating,
  editingTemplate,
  onSave,
  isSaving,
}: {
  onClose: () => void;
  onCreate: (payload: TemplateFormPayload) => void;
  isCreating: boolean;
  // When set, the modal opens pre-filled from this DRAFT template and the
  // primary button saves changes to it (PATCH) instead of creating a new
  // template (POST) — see updateFormTemplateContent, which already existed
  // on the backend/api client but had no UI ever calling it: "New version"
  // cloned a template into a fresh draft with no way to actually change its
  // fields before submitting, a dead end this closes.
  editingTemplate?: EditableTemplate;
  onSave?: (id: string, payload: TemplateFormPayload) => void;
  isSaving?: boolean;
}) {
  const [name, setName] = useState(editingTemplate?.name ?? '');
  const [category, setCategory] = useState(editingTemplate?.category ?? '');
  // Who can use this form. Without organisation-level authority only a department the author belongs to may be
  // chosen (the server enforces it: ERR-FORM-SCOPE-REQUIRED / ERR-FORM-SCOPE); a lone department is pre-selected.
  const { can } = usePermissions();
  const orgLevel = hasOrgLevelAuthority(can);
  const { departments: myDepartments } = useMyDepartments(!orgLevel);
  const [scope, setScope] = useState(() => initialScope(editingTemplate, orgLevel, undefined));
  const effectiveScope = !orgLevel && scope.kind === 'department' && !scope.departmentId && myDepartments.length === 1
    ? { ...scope, departmentId: myDepartments[0]!.id }
    : scope;
  // Rec §7.2: 'chain' = every filled instance flows through the approval engine.
  const [instanceApproval, setInstanceApproval] = useState<'none' | 'chain'>(editingTemplate?.instanceApproval ?? 'none');
  // Per-template governance (SYSTEM-DECISIONS.md D5/D8) — only take effect
  // once a filled instance actually goes through the approval chain above,
  // so the controls are only shown when that's on.
  const [auditPolicy, setAuditPolicy] = useState<'required' | 'optional' | 'never'>(editingTemplate?.auditPolicy ?? 'never');
  const [signingPolicy, setSigningPolicy] = useState<'none' | 'ceremony'>(editingTemplate?.signingPolicy ?? 'none');
  const [sections, setSections] = useState<SectionMeta[]>(editingTemplate?.sectionsJson ?? []);
  const [fields, setFields] = useState<BuilderField[]>(() =>
    editingTemplate
      ? fromSchema(editingTemplate.schemaJson)
      : [
          { id: 'subject', name: 'subject', label: 'Subject', type: 'text', required: true },
          { id: 'requested_date', name: 'requested_date', label: 'Requested date', type: 'date', required: false },
        ],
  );
  const [basePdfObjectKey, setBasePdfObjectKey] = useState<string | undefined>(editingTemplate?.basePdfObjectKey ?? undefined);
  const [basePdfName, setBasePdfName] = useState(editingTemplate?.basePdfObjectKey ? (editingTemplate.isLetterhead ? 'Example Corp Letterhead' : 'Existing base file') : '');
  const [uploadingBasePdf, setUploadingBasePdf] = useState(false);
  // A pre-printed scan already has its own field captions on the page and
  // typically fills the whole page — a branding-only letterhead (header/
  // footer banner, no captions) needs the opposite: labels drawn, and
  // content kept clear of the artwork (see schema.ts's Y_START_LETTERHEAD/
  // Y_MAX_LETTERHEAD). Meaningless without a base file.
  const [isLetterhead, setIsLetterhead] = useState(Boolean(editingTemplate?.isLetterhead));
  const [loadingLetterhead, setLoadingLetterhead] = useState(false);
  // Suggestions for the category field (see api.ts's listFormTemplateCategories)
  // — best-effort only: an empty list just means an empty datalist, never a
  // blocking error, since category is (and stays) a free-text field.
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    listFormTemplateCategories()
      .then((res) => { if (!cancelled) setCategoryOptions(res.data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Mounted only while open (the parent conditionally renders this component).
  useModalA11y(true, onClose);

  const previewSchema = useMemo(
    () => toSchema(fields, sections, Boolean(basePdfObjectKey) && isLetterhead),
    [fields, sections, basePdfObjectKey, isLetterhead],
  );

  // Live preview: renders the ACTUAL generated PDF (same @pdfme/generator
  // pipeline the real fill-form flow uses, with sample data) rather than
  // reimplementing pdfme's layout engine in HTML/CSS — see the backend's
  // previewFormTemplatePdf / POST /forms/templates/preview. Debounced so
  // every keystroke while editing fields doesn't hit the backend.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  // Which page of the generated PDF the preview pane is showing — the
  // template can span multiple pages (see schema.ts's toSchema() page
  // breaks), so a single fixed-aspect-ratio iframe can only ever show one
  // page at a time; this lets the author actually page through all of them
  // instead of only ever seeing page 1 with a text note saying more exist.
  const [previewPage, setPreviewPage] = useState(1);
  const previewPageCount = Math.max(1, previewSchema.length);

  // The preview's loading/error flags are a pure function of the inputs below,
  // so they are adjusted during render rather than set synchronously in the
  // effect (react-hooks/set-state-in-effect). The debounced render request
  // itself stays an effect.
  useResetOnChange([fields.length === 0, previewSchema, basePdfObjectKey, isLetterhead, name], () => {
    setPreviewError(null);
    setPreviewLoading(fields.length > 0);
  });

  useEffect(() => {
    if (fields.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const blob = await previewFormTemplatePdf({ schemaJson: previewSchema, basePdfObjectKey, isLetterhead: Boolean(basePdfObjectKey) && isLetterhead, name });
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = url;
        setPreviewUrl(url);
        // A fresh render starts back at page 1 — otherwise editing a field
        // while looking at page 3 of a since-shrunk template would leave the
        // pager pointed past the end (or the browser's PDF viewer silently
        // clamping to the last page without telling the author why the
        // preview "jumped").
        setPreviewPage(1);
      } catch (e) {
        if (!cancelled) setPreviewError(e instanceof Error ? e.message : 'Preview failed');
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewSchema, basePdfObjectKey, name]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const disabledReason = !name.trim()
    ? 'Enter a template name'
    : fields.length === 0
      ? 'Add at least one field'
      : scopeProblem(effectiveScope);

  const addField = (section?: string) =>
    setFields((f) => {
      // `field_${f.length + 1}` collided after an add/delete/add cycle (e.g.
      // add field_3, delete it, add again -> field_3 already taken by a
      // field added earlier), silently duplicating a `name` — which is the
      // form's stable data key, so a collision breaks value keying, the
      // generated PDF (duplicate schema entry names), and React's list keys
      // downstream. Find the lowest free suffix instead of trusting length.
      const existingNames = new Set(f.map((x) => x.name));
      let n = f.length + 1;
      while (existingNames.has(`field_${n}`)) n++;
      return [...f, { id: crypto.randomUUID(), name: `field_${n}`, label: `Field ${n}`, type: 'text', required: false, section }];
    });
  const updateField = (id: string, patch: Partial<BuilderField>) =>
    setFields((list) => list.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const addSection = () =>
    setSections((s) => [...s, { id: crypto.randomUUID(), label: `Section ${s.length + 1}`, order: s.length }]);
  const updateSection = (id: string, label: string) =>
    setSections((list) => list.map((s) => (s.id === id ? { ...s, label } : s)));
  const removeSection = (id: string) => {
    setSections((list) => list.filter((s) => s.id !== id));
    setFields((list) => list.map((f) => (f.section === id ? { ...f, section: undefined } : f)));
  };
  // Sections render in array order (schema.ts's toSchema iterates them in
  // this same order, "General" always first) — this was previously fixed at
  // creation time with no way to change it short of delete-and-recreate.
  const moveSection = (id: string, dir: -1 | 1) =>
    setSections((list) => {
      const i = list.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i === -1 || j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      return next.map((s, idx) => ({ ...s, order: idx }));
    });

  const onPickBasePdf = async (file: File | undefined) => {
    if (!file) return;
    if (!ALLOWED_BASE_FILE_TYPES.has(file.type)) {
      if (/\.docx?$/i.test(file.name)) {
        toast.error("DOCX isn't supported yet — please upload a PDF, PNG, JPEG, WEBP, or GIF, or export your document to PDF first");
      } else {
        toast.error('Unsupported file type — please upload a PDF, PNG, JPEG, WEBP, or GIF');
      }
      return;
    }
    setUploadingBasePdf(true);
    try {
      const res = await uploadFormBasePdf(file);
      setBasePdfObjectKey(res.data.objectKey);
      setBasePdfName(file.name);
      setIsLetterhead(false); // a manually uploaded file defaults to "pre-printed scan" — author opts into letterhead mode explicitly
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Base file upload failed');
    } finally {
      setUploadingBasePdf(false);
    }
  };

  const onUseExampleCorpLetterhead = async () => {
    setLoadingLetterhead(true);
    try {
      const res = await getExampleCorpLetterheadObjectKey();
      setBasePdfObjectKey(res.data.objectKey);
      setBasePdfName('Example Corp Letterhead');
      setIsLetterhead(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load the Example Corp letterhead');
    } finally {
      setLoadingLetterhead(false);
    }
  };

  // AI-assisted authoring ("Build from a photo or PDF") — see api.ts's
  // extractFormFieldsFromImage. Appends to whatever's already in the
  // builder rather than replacing it, so re-running this (or running it
  // after manually adding a few fields) never silently discards work; a
  // second run just adds another batch alongside the first.
  const [extractingFields, setExtractingFields] = useState(false);
  const onExtractFromImage = async (file: File | undefined) => {
    if (!file) return;
    setExtractingFields(true);
    try {
      const res = await extractFormFieldsFromImage(file);
      // Map the AI's own sectionId (arbitrary strings it invented) onto real
      // SectionMeta ids so they don't collide with whatever the author has
      // already created — appended after existing sections, in the order
      // the model returned them (its own reading order top-to-bottom).
      const sectionIdMap = new Map<string, string>();
      const newSections: SectionMeta[] = res.data.sections.map((s, i) => {
        const id = crypto.randomUUID();
        sectionIdMap.set(s.id, id);
        return { id, label: s.label, order: sections.length + i };
      });
      const existingNames = new Set(fields.map((f) => f.name));
      const newFields: BuilderField[] = res.data.fields.map((f, i) => {
        let n = existingNames.size + i + 1;
        let name = slug(f.label) || `field_${n}`;
        while (existingNames.has(name)) { n += 1; name = `field_${n}`; }
        existingNames.add(name);
        return {
          id: crypto.randomUUID(),
          name,
          label: f.label,
          type: (f.type as BuilderField['type']) || 'text',
          required: f.required,
          section: f.sectionId ? sectionIdMap.get(f.sectionId) : undefined,
          layoutWidth: f.layoutWidth ?? 'full',
          options: f.options,
        };
      });
      setSections((s) => [...s, ...newSections]);
      setFields((f) => [...f, ...newFields]);
      toast.success(`Added ${newFields.length} field${newFields.length === 1 ? '' : 's'} — review and adjust them below before saving.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not read that file');
    } finally {
      setExtractingFields(false);
    }
  };

  // Jump the live PDF preview to whichever page a clicked field actually
  // lands on — the one direct link between "editing this field" and "seeing
  // its real effect" beyond re-reading the whole preview each time.
  const onFieldFocusJumpPreview = (field: BuilderField) => {
    const pageIndex = previewSchema.findIndex((page) => page.some((f) => f.name === field.name));
    if (pageIndex >= 0) setPreviewPage(pageIndex + 1);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,.5)' }}>
      <div className="rounded-xl p-6 w-full max-w-5xl shadow-xl max-h-[90vh] overflow-y-auto" style={{ background: 'var(--surface-raised)' }} role="dialog" aria-modal="true" aria-labelledby="template-builder-modal-title">
        <div className="flex items-center justify-between mb-4">
          <h2 id="template-builder-modal-title" className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{editingTemplate ? `Edit draft — ${editingTemplate.name}` : 'New Form Template'}</h2>
          <button onClick={onClose} className="text-sm" style={{ color: 'var(--text-muted)' }}>Close</button>
        </div>

        <div
          className="rounded-lg p-3 mb-4 flex flex-wrap items-center gap-3"
          style={{ background: 'rgba(124,58,237,0.06)', border: '1px solid rgba(124,58,237,0.25)' }}
        >
          <Sparkles size={18} className="shrink-0" style={{ color: '#7c3aed' }} />
          <div className="flex-1 min-w-[200px]">
            <p className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>Have a paper form or an existing PDF?</p>
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Upload a photo or PDF of it and AI will read the fields and add them below for you to check over — nothing is
              saved until you review it and click {editingTemplate ? 'Save draft' : 'Create template'}.
            </p>
          </div>
          <label className={`ui-btn ${extractingFields ? 'ui-btn-secondary' : 'ui-btn-primary'} cursor-pointer shrink-0`}>
            {extractingFields ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {extractingFields ? 'Reading…' : 'Build from a photo or PDF'}
            <input
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              disabled={extractingFields}
              onChange={(e) => { void onExtractFromImage(e.target.files?.[0]); e.target.value = ''; }}
            />
          </label>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-secondary)' }} htmlFor="form-template-name">Template name</label>
            <input id="form-template-name" className="ui-input" value={name} maxLength={255} onChange={(e) => setName(e.target.value)} placeholder="Template name" />
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-secondary)' }} htmlFor="form-template-category">Category</label>
            <input id="form-template-category" className="ui-input" list="form-template-category-options" value={category} maxLength={100} onChange={(e) => setCategory(e.target.value)} placeholder="Category" />
            <datalist id="form-template-category-options">
              {categoryOptions.map((c) => <option key={c} value={c} />)}
            </datalist>
          </div>
          <button onClick={() => addField()} className="ui-btn ui-btn-secondary self-end"><Plus size={15} /> Add field</button>
        </div>

        <div className="mt-4">
          <ScopeSelect
            idPrefix="form-template"
            label="Who can use this form"
            value={effectiveScope}
            onChange={setScope}
            orgLevel={orgLevel}
          />
        </div>

        <div className="mt-4 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
          <p className="text-xs font-bold uppercase mb-2" style={{ color: 'var(--text-muted)' }}>Base file (optional)</p>
          <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
            Overlay fields onto an existing PDF, PNG, JPEG, WEBP, or GIF (e.g. a pre-printed letterhead form or a scan) instead of a blank generated page. The generated/filled form is always a PDF.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="ui-btn ui-btn-secondary cursor-pointer">
              <Upload size={14} /> {uploadingBasePdf ? 'Uploading…' : 'Upload file'}
              <input type="file" accept={BASE_FILE_ACCEPT} className="hidden" disabled={uploadingBasePdf} onChange={(e) => onPickBasePdf(e.target.files?.[0])} />
            </label>
            <button onClick={onUseExampleCorpLetterhead} disabled={loadingLetterhead} className="ui-btn ui-btn-secondary" title="Brand this form with the Example Corp header/footer letterhead">
              <Building2 size={14} /> {loadingLetterhead ? 'Loading…' : 'Use Example Corp Letterhead'}
            </button>
            {basePdfName && <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{basePdfName}</span>}
            {basePdfObjectKey && (
              <button onClick={() => { setBasePdfObjectKey(undefined); setBasePdfName(''); setIsLetterhead(false); }} className="text-xs" style={{ color: 'var(--danger)' }}>Remove</button>
            )}
          </div>
          {basePdfObjectKey && (
            <label className="mt-2 flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}
              title="On: this file is a blank branding letterhead with no field captions of its own — the system draws field labels and keeps content clear of its header/footer artwork. Off: this file is a pre-printed form/scan that already has its own field captions printed on it.">
              <input type="checkbox" checked={isLetterhead} onChange={(e) => setIsLetterhead(e.target.checked)} />
              This is a branding letterhead (no field captions printed on it) — draw labels and avoid the header/footer
            </label>
          )}
        </div>

        <div className="mt-4 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)' }}>Sections</p>
            <button onClick={addSection} className="ui-btn ui-btn-secondary !py-1 !px-2 text-xs"><Plus size={12} /> Add section</button>
          </div>
          <p className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
            A <strong>section</strong> is just a heading that groups related fields together (e.g. &quot;Applicant info&quot;) —
            sections print in the order shown here, top to bottom. A <strong>field</strong> is one input someone actually
            fills in (e.g. &quot;Full name&quot;). Drag a field&apos;s grip handle below (or use its up/down arrows) to reorder
            it, and give two fields Half width so they sit side by side on the same row.
          </p>
          {sections.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No sections yet — fields render under &quot;General&quot;.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {sections.map((s, i) => (
                <div key={s.id} className="flex items-center gap-1 rounded-full px-2 py-1" style={{ background: 'var(--surface-base)' }}>
                  <div className="flex flex-col -my-1">
                    <button onClick={() => moveSection(s.id, -1)} disabled={i === 0} className="disabled:opacity-20" title="Move section earlier">
                      <ArrowUp size={10} style={{ color: 'var(--text-muted)' }} />
                    </button>
                    <button onClick={() => moveSection(s.id, 1)} disabled={i === sections.length - 1} className="disabled:opacity-20" title="Move section later">
                      <ArrowDown size={10} style={{ color: 'var(--text-muted)' }} />
                    </button>
                  </div>
                  <input
                    className="bg-transparent text-xs outline-none"
                    style={{ color: 'var(--text-primary)', width: `${Math.max(6, s.label.length)}ch` }}
                    value={s.label}
                    onChange={(e) => updateSection(s.id, e.target.value)}
                  />
                  <button onClick={() => removeSection(s.id)}><Trash2 size={12} style={{ color: 'var(--text-muted)' }} /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
          <div>
            {fields.length === 0 && (
              <div className="rounded-lg border border-dashed p-6 text-center mb-3" style={{ borderColor: 'var(--border)' }}>
                <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>No fields yet</p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  Click &quot;Add field&quot; above, or upload a photo/PDF of an existing form to start from.
                </p>
              </div>
            )}
            <FormCanvas
              fields={fields}
              sections={sections}
              onFieldsChange={setFields}
              onFieldChange={updateField}
              onFieldDelete={(id) => setFields((list) => list.filter((x) => x.id !== id))}
              onAddField={addField}
              onFieldFocus={onFieldFocusJumpPreview}
            />
          </div>
          <div className="rounded-lg border p-4" style={{ borderColor: 'var(--border)', background: 'var(--surface-card)' }}>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)' }}>Live preview</p>
              <div className="flex items-center gap-2">
                {previewLoading && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Rendering…</span>}
                {previewUrl && !previewError && previewPageCount > 1 && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setPreviewPage((p) => Math.max(1, p - 1))}
                      disabled={previewPage <= 1}
                      className="ui-btn-icon !p-1 disabled:opacity-30"
                      aria-label="Previous page"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                      Page {previewPage} of {previewPageCount}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPreviewPage((p) => Math.min(previewPageCount, p + 1))}
                      disabled={previewPage >= previewPageCount}
                      className="ui-btn-icon !p-1 disabled:opacity-30"
                      aria-label="Next page"
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="aspect-[210/297] rounded border overflow-hidden" style={{ borderColor: 'var(--border)', background: 'white' }}>
              {fields.length === 0 ? (
                <p className="p-3 text-xs" style={{ color: 'var(--text-muted)' }}>Add a field to see a preview.</p>
              ) : previewError ? (
                <p className="p-3 text-xs" style={{ color: 'var(--danger)' }}>{previewError}</p>
              ) : previewUrl ? (
                // #page=N jumps the browser's native PDF viewer straight to
                // that page — re-navigates on every previewPage change since
                // it's part of the iframe's src.
                <iframe key={previewUrl} src={`${previewUrl}#page=${previewPage}`} className="w-full h-full border-0" title={`Form template preview, page ${previewPage} of ${previewPageCount}`} />
              ) : (
                <p className="p-3 text-xs" style={{ color: 'var(--text-muted)' }}>Rendering preview…</p>
              )}
            </div>
            <p className="mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
              This is the actual PDF the system will generate — sample values stand in for real submitted data.
              {previewPageCount > 1 && ` Spans ${previewPageCount} pages at this field count — use the pager above to check every page.`}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3 mt-5">
          <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}
            title="When on, every filled instance is auto-submitted through the approval engine (fill → chain → approved) instead of filing immediately.">
            <input
              type="checkbox"
              checked={instanceApproval === 'chain'}
              onChange={(e) => setInstanceApproval(e.target.checked ? 'chain' : 'none')}
            />
            Filled instances require approval (chain)
          </label>
          {instanceApproval === 'chain' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pl-6 border-l-2" style={{ borderColor: 'var(--border-subtle)' }}>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-secondary)' }}>Audit stage</label>
                <select className="ui-input text-sm" value={auditPolicy} onChange={(e) => setAuditPolicy(e.target.value as typeof auditPolicy)}>
                  <option value="never">Never audited</option>
                  <option value="optional">Approver decides</option>
                  <option value="required">Always audited</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-secondary)' }}>Signing</label>
                <select className="ui-input text-sm" value={signingPolicy} onChange={(e) => setSigningPolicy(e.target.value as typeof signingPolicy)}>
                  <option value="none">No ceremony</option>
                  <option value="ceremony">E-sign ceremony after approval</option>
                </select>
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>Approved instances go to Pending Signature before archiving.</p>
              </div>
            </div>
          )}
          <div className="flex justify-end items-center gap-3">
            {disabledReason && <span className="text-xs" style={{ color: 'var(--color-amber-500)' }}>{disabledReason}</span>}
            <button onClick={onClose} className="ui-btn ui-btn-secondary">Cancel</button>
            <button
              disabled={!!disabledReason || isCreating || isSaving || uploadingBasePdf}
              onClick={() => {
                const payload: TemplateFormPayload = { name: name.trim(), category: category.trim() || undefined, basePdfObjectKey, isLetterhead: Boolean(basePdfObjectKey) && isLetterhead, schemaJson: previewSchema, sectionsJson: sections, instanceApproval, auditPolicy, signingPolicy, ...scopePayload(effectiveScope) };
                if (editingTemplate && onSave) onSave(editingTemplate.id, payload);
                else onCreate(payload);
              }}
              className="ui-btn ui-btn-primary"
            >
              {editingTemplate ? (isSaving ? 'Saving…' : 'Save draft') : 'Create template'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
