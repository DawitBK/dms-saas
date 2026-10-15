export type Template = {
  basePdf: string | Uint8Array;
  schemas: unknown[];
};

export type Font = Record<string, unknown>;

// forms.service.ts's buildPdfmeFontMap() calls this for real (not type-only)
// at module scope every time it renders a PDF — needed for ANY jest test that
// imports forms.service.ts, not just this one, so it lives in the shared mock.
export function getDefaultFont(): Record<string, unknown> {
  return { Roboto: { data: Buffer.from(''), fallback: true } };
}
