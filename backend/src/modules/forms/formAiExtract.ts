// AI-assisted form-template authoring: given a photo or PDF of what a paper
// (or existing digital) form looks like, asks a vision-capable model to read
// it and propose a structured field list — sections, field labels/types/
// required-ness/layout — to pre-populate the template builder with, instead
// of the admin adding every field one at a time from a blank canvas.
//
// Deliberately NOT auto-saved as a template: this returns a proposal for the
// builder UI to load into its normal editable state (same BuilderField[]
// shape a human-authored template already produces), so the admin reviews
// and corrects it before anything is persisted — a vision model's read of a
// scanned, handwritten, or low-quality photo is a starting point, not a
// guaranteed-correct answer.

import sharp from 'sharp';
import { AppError } from '../../core/AppError.js';
import { logger } from '../../core/logger.js';
import { scanBuffer } from '../../infrastructure/antivirus/clamscan.js';
import { rasterizeFirstPdfPage } from '../../shared/pdfRasterize.js';
import { ocrImage } from '../../shared/ocr.js';
import { llmExtractStructured, llmChat, type LlmToolDef } from '../ai/llmClient.js';
import { authorizeAiRequest, recordAiUsage } from '../ai/aiPolicy.service.js';
import type { AuthenticatedUser } from '../../shared/auth.js';

const SUPPORTED_INPUT_MIMETYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_INPUT_BYTES = 15 * 1024 * 1024; // 15MB — generous for a phone photo or a scanned page

// Mirrors frontend/features/forms/schema.ts's FieldType union — deliberately
// a loose re-declaration rather than a shared import: the frontend and
// backend are separate TypeScript projects/builds in this repo (same
// convention already used by forms.service.ts's own FormFieldSchema
// interface, see that file's comment). Keep both in sync if a field type is
// ever added or removed.
const FIELD_TYPES = ['text', 'textarea', 'date', 'number', 'checkbox', 'select', 'radio', 'email', 'file'];

const EXTRACT_TOOL: LlmToolDef = {
  name: 'submit_form_fields',
  description: 'Submits the structured list of fields (and optional groupings/sections) found on the form in the image.',
  parameters: {
    type: 'object',
    properties: {
      sections: {
        type: 'array',
        description: 'Optional groupings the form visually uses (e.g. "Applicant Details", "Employment History"). Omit entirely if the form has no clear sections.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'A short, stable, lowercase-with-dashes id, e.g. "applicant-details".' },
            label: { type: 'string', description: 'The human-readable heading as printed on the form.' },
          },
          required: ['id', 'label'],
        },
      },
      fields: {
        type: 'array',
        description: 'Every fillable field on the form, in the same top-to-bottom, left-to-right reading order they appear.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'The field caption exactly as printed (e.g. "Full Name", "Date of Birth"). Always your best reading of the actual printed text nearest the field — never a generic placeholder like "Field 1" even if the caption is small, faint, or partly unclear.' },
            type: {
              type: 'string',
              enum: FIELD_TYPES,
              description:
                'Best-guess input type — read the field\'s CAPTION, not just its drawn control, before picking one. ' +
                '"checkbox" is ONLY for a single true/false tick against one caption (e.g. a lone "[ ] I agree" or "[ ] Married"). ' +
                'If the caption names a CATEGORY (e.g. "Type of Leave", "Marital Status", "Department", "Payment Method") — even if the ' +
                'form draws it as several small boxes/circles, one per option (e.g. "[ ] Annual [ ] Sick [ ] Unpaid") — that is ONE ' +
                '"select" or "radio" field with those words as its options, never a bare "checkbox". A caption asking for a count, ' +
                'amount, or number of days/years is "number". A field whose caption is basically the same as another field\'s except for ' +
                'a year or index (e.g. "2024 Budget Year Days" / "2025 Budget Year Days" / "2026 Budget Year Days") is the same KIND of ' +
                'field repeated — give every one of that repeated group the identical type, never mix "number" and "text" across them. ' +
                'Use "textarea" for a field with several blank lines; otherwise "text".',
            },
            required: { type: 'boolean', description: 'True if the form marks this field as mandatory (e.g. an asterisk) — otherwise false.' },
            sectionId: { type: 'string', description: 'The id of the section (from the sections list) this field belongs under, if any.' },
            layoutWidth: { type: 'string', enum: ['full', 'half', 'third', 'quarter'], description: 'How much of a row this field visually occupies on the form. Look at the field\'s vertical (y) position relative to its neighbors: if 2, 3, or 4 field captions sit at THE SAME height on the page (side by side, e.g. "First Name"/"Last Name", or "Request From"/"Request To"), that is a strong signal — mark each of them "half" (2 sharing the row), "third" (3 sharing it), or "quarter" (4 sharing it), not "full". Reserve "full" for a field that genuinely has no neighbor at its height (e.g. Address, Comments, or any long-text/textarea field spanning the whole width). Most forms use side-by-side pairs somewhere — check for that before defaulting to "full".' },
            options: { type: 'array', items: { type: 'string' }, description: 'Only for type "select"/"radio": the exact list of choices printed on the form.' },
          },
          required: ['label', 'type', 'required', 'layoutWidth'],
        },
      },
    },
    required: ['fields'],
  },
};

export interface ExtractedFormField {
  label: string;
  type: string;
  required: boolean;
  sectionId?: string;
  layoutWidth?: 'full' | 'half' | 'third' | 'quarter';
  options?: string[];
}

export interface ExtractedFormFields {
  sections: Array<{ id: string; label: string }>;
  fields: ExtractedFormField[];
}

const SYSTEM_PROMPT = `You are a meticulous forms analyst. You are shown one image of a paper or digital form.
Your only job is to identify every fillable field visible on it, in top-to-bottom, left-to-right reading order.

Rules:
- Call submit_form_fields with the structured field list.
- If the tool call mechanism is unavailable, respond with ONLY a raw JSON object matching this schema:
  {"sections": [{"id": string, "label": string}], "fields": [{"label": string, "type": string, "required": boolean, "layoutWidth": string, "sectionId"?: string, "options"?: string[]}]}
- Do NOT invent fields not visible on the form.
- Do NOT add placeholder/example data.
- If the image has no form fields, return {"sections": [], "fields": []}
- Never reply with narrative text — only the tool call or the raw JSON object.
- Pay close attention to the form's actual visual layout, not just its text. Many forms print two, three, or
  even four short fields side by side on the same horizontal line (e.g. "First Name" next to "Last Name", or
  "Date From" next to "Date To") — reproduce that with each field's layoutWidth ("half"/"third"/"quarter")
  rather than flattening the whole form into a single vertical column of "full"-width fields. Only use "full"
  for a field that truly has no neighbor at its height.
- Many forms in this organization are printed in Amharic (Ge'ez script), English, or a mix of both on the same
  page. Copy every label, section heading, and option exactly as printed, in whatever language/script it is
  actually written in — NEVER translate Amharic to English (or vice versa) and never transliterate. A form
  with Amharic captions must come back with Amharic captions; this pipeline renders that text correctly
  downstream, so translating it would only lose information, not help.`;

const VISION_PROMPT = 'Look carefully at every label, blank line, checkbox, dropdown, and input box on this form, AND at how they are visually arranged — which ones sit side by side on the same row versus alone on their own row. Call submit_form_fields with ALL of them in reading order, setting layoutWidth per field to match that arrangement. If you cannot use the tool, output the raw JSON object described in the system prompt.';

/**
 * Reads an uploaded image or PDF (first page) of a form and returns a
 * proposed field list via a vision-capable model. Throws AppError on any
 * failure (AI not configured/consented, bad input, extraction failure) —
 * there is no partial/best-effort result, since a half-populated field list
 * with no way to tell which half is real would be worse than a clear error.
 */
export async function extractFormFieldsFromImage(
  file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
  user: AuthenticatedUser,
): Promise<ExtractedFormFields> {
  // Two-step authorisation (aiPolicy.service.ts). Here, before any bytes are
  // looked at: consent (tenant ai_processing flag) and the form_extraction switch,
  // 'verify' mode = no quota check and NO debit. The quota is debited further down,
  // immediately before the first call to the provider — a wrong file type, an
  // oversized file or an undecodable image must not use up one of the user's
  // (default 100/day) AI requests. No document is involved, so the content rules
  // do not apply to a photo of a blank form.
  await authorizeAiRequest({ tenantId: user.tenantId, userId: user.userId, feature: 'form_extraction', mode: 'verify' });

  if (!SUPPORTED_INPUT_MIMETYPES.has(file.mimetype)) {
    throw new AppError(422, 'ERR-FORM-EXTRACT-TYPE', 'Upload a PDF, PNG, JPEG, WEBP, or GIF of the form');
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new AppError(422, 'ERR-FORM-EXTRACT-TOO-LARGE', `File exceeds the ${MAX_INPUT_BYTES / (1024 * 1024)}MB limit`);
  }

  const avScanStatus = await scanBuffer(file.buffer);
  if (avScanStatus === 'unscanned') {
    logger.warn({ tenantId: user.tenantId, filename: file.originalname }, '[forms] AI form-extraction upload allowed through unscanned (clamav did not complete)');
  }

  // Normalize everything to a single PNG frame the vision call sends — a PDF
  // page is rasterized (form templates are one page; only the first page of
  // a multi-page upload is read), an image is re-encoded through sharp the
  // same way every other image-accepting path in this codebase already does,
  // so an unusual-but-valid format never reaches the provider in a shape it
  // might reject.
  //
  // Both decoders throw on a corrupt/truncated/not-actually-that-format file
  // (confirmed live: a malformed PNG throws sharp's own "vipspng: libpng read
  // error" straight out of native code) — caught here and turned into the
  // same clean, expected-to-happen 422 every other bad-input case in this
  // function already gets, instead of an unhandled ERR-INTERNAL 500.
  //
  // FIX: Groq enforces a 4MB base64 limit for vision input. A full-resolution
  // phone photo re-encoded as PNG easily exceeds that, causing the vision call
  // to fail and fall through to OCR (which gives much worse results for images
  // vs real scanned documents). Cap at 1800×1800px — large enough to read all
  // form field text legibly, small enough to stay well under the limit at any
  // normal form image quality.
  const VISION_MAX_PX = 1800;
  let pngBytes: Buffer;
  try {
    const rawPng = file.mimetype === 'application/pdf'
      ? await rasterizeFirstPdfPage(file.buffer)
      : await sharp(file.buffer).png().toBuffer();
    // Resize only if needed — withoutEnlargement leaves small images untouched.
    pngBytes = await sharp(rawPng)
      .resize(VISION_MAX_PX, VISION_MAX_PX, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 8 })
      .toBuffer();
    logger.info({ tenantId: user.tenantId, filename: file.originalname, pngKb: Math.round(pngBytes.length / 1024) }, '[forms] image normalized for vision extraction');
  } catch (err) {
    logger.warn({ tenantId: user.tenantId, filename: file.originalname, mimetype: file.mimetype, err: err instanceof Error ? err.message : err }, '[forms] AI form-extraction could not decode the uploaded file');
    throw new AppError(422, 'ERR-FORM-EXTRACT-UNREADABLE', "Couldn't read that file as an image — it may be corrupted or an unsupported variant. Try a clearer photo, a plain PDF, or a different file.");
  }

  // From here on the request leaves the building (vision model, or OCR text to
  // the LLM): debit the quota, then record how it ended in the same ledger
  // (ai_usage_events) so the AI Controls usage screen shows completed/failed.
  await authorizeAiRequest({ tenantId: user.tenantId, userId: user.userId, feature: 'form_extraction' });
  try {
    let result: Record<string, unknown> = {};

    // Vision-first: hand the normalized PNG straight to a vision-capable model
    // via llmExtractStructured. This reads the form's actual layout — checkbox
    // vs. text field, column position, blank-line length — none of which
    // survives OCR's plain-text extraction. Only falls back to OCR when the
    // vision call itself fails: no vision-capable model configured on the
    // active provider (see GROQ_VISION_MODEL/etc.), or the model declines to
    // call the tool.
    let visionFailed = false;
    try {
      result = await llmExtractStructured({
        system: SYSTEM_PROMPT,
        prompt: VISION_PROMPT,
        images: [{ mimeType: 'image/png', base64: pngBytes.toString('base64') }],
        tool: EXTRACT_TOOL,
        maxTokens: 4096,
      });
    } catch (err) {
      visionFailed = true;
      logger.warn(
        { tenantId: user.tenantId, filename: file.originalname, err: err instanceof Error ? err.message : err },
        '[forms] vision extraction failed, falling back to OCR',
      );
    }

    if (visionFailed) {
      // OCR-optimised preprocessing: the standard pipeline (grayscale + normalize +
      // sharpen) leaves photographic noise and grey backgrounds intact, which
      // Tesseract misreads as extra characters. Adding a median blur before the
      // sharpen removes salt-and-pepper noise, and a threshold binarization turns
      // the image to pure black-on-white — the format Tesseract is most accurate on.
      let ocrReadyBuffer: Buffer;
      try {
        ocrReadyBuffer = await sharp(pngBytes)
          .grayscale()
          .median(3)                // remove camera/scan noise before sharpening
          .normalize()              // stretch histogram — improves low-contrast photos
          .sharpen({ sigma: 1.5 }) // crisp up text edges
          .threshold(140)           // binarize: pure black-on-white, eliminates grey backgrounds
          .png()
          .toBuffer();
      } catch {
        // If advanced preprocessing fails (unusual image mode), fall back to basic grayscale
        ocrReadyBuffer = await sharp(pngBytes).grayscale().normalize().sharpen().toBuffer();
      }

      const ocrText = await ocrImage(ocrReadyBuffer);
      if (!ocrText || !ocrText.trim()) {
        throw new AppError(
          422,
          'ERR-FORM-EXTRACT-UNREADABLE',
          "Couldn't detect any readable text or form fields on that file — try a clearer, higher-contrast photo, or a plain PDF.",
        );
      }

      const ocrPrompt = `You are analyzing a form from its OCR text extraction:\n\n=== OCR TEXT ===\n${ocrText}\n================\n\nIdentify every fillable field, label, type, and section on this form and call submit_form_fields.`;

      try {
        const chatResult = await llmChat({
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: ocrPrompt }],
          tools: [EXTRACT_TOOL],
          forceTool: EXTRACT_TOOL.name,
          maxTokens: 4096,
        });

        const call = chatResult.toolCalls.find((tc) => tc.name === EXTRACT_TOOL.name);
        if (call && call.arguments && typeof call.arguments === 'object') {
          result = call.arguments;
        } else if (chatResult.text) {
          const match = chatResult.text.match(/\{[\s\S]*\}/);
          if (match) {
            try {
              result = JSON.parse(match[0]);
            } catch {
              // pass
            }
          }
        }
      } catch (llmErr) {
        logger.error({ err: llmErr }, '[forms] OCR LLM structured extraction failed');
        throw new AppError(
          502,
          'ERR-AI-PROVIDER',
          'AI provider failed during form extraction. Please check the AI provider configuration or try again in a few moments.',
        );
      }
    }

    const sections = Array.isArray(result.sections)
      ? (result.sections as Array<{ id?: unknown; label?: unknown }>)
          .filter((s) => typeof s.id === 'string' && typeof s.label === 'string')
          .map((s) => ({ id: String(s.id), label: String(s.label) }))
      : [];
    const fields = Array.isArray(result.fields)
      ? (result.fields as Array<Record<string, unknown>>)
          .filter((f) => typeof f.label === 'string' && typeof f.type === 'string')
          .map((f): ExtractedFormField => ({
            label: String(f.label),
            type: FIELD_TYPES.includes(f.type as string) ? (f.type as string) : 'text',
            required: Boolean(f.required),
            sectionId: typeof f.sectionId === 'string' ? f.sectionId : undefined,
            layoutWidth: (['full', 'half', 'third', 'quarter'] as const).includes(f.layoutWidth as any) ? (f.layoutWidth as any) : 'full',
            options: Array.isArray(f.options) ? f.options.filter((o): o is string => typeof o === 'string') : undefined,
          }))
      : [];

    if (fields.length === 0) {
      throw new AppError(
        422,
        'ERR-FORM-EXTRACT-EMPTY',
        "Couldn't find any fields on that image — try a clearer photo, or add fields manually.",
      );
    }

    await recordAiUsage({ tenantId: user.tenantId, userId: user.userId, feature: 'form_extraction', trigger: 'user', outcome: 'completed' });
    return { sections, fields };
  } catch (err) {
    await recordAiUsage({
      tenantId: user.tenantId, userId: user.userId, feature: 'form_extraction', trigger: 'user', outcome: 'failed',
      reason: err instanceof Error ? err.message.slice(0, 500) : 'unknown error',
    });
    throw err;
  }
}
