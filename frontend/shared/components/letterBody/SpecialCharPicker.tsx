'use client';

// Every symbol here is deliberately within the WinAnsi (Windows-1252) or
// embedded-Ethiopic-font-carried-Latin range the backend PDF renderer
// (letterPdf.ts's isWinAnsiChar/WINANSI_EXTRA_CODEPOINTS) already draws
// directly — currency, punctuation, and math symbols mostly are (€, £, ©,
// ®, ™, §, ¶, °, ±, ×, ÷ all sit in cp1252 or Latin-1). True arrow/checkmark
// glyphs (→, ✓) sit outside both WinAnsi and the embedded Ethiopic font's
// charset and would degrade to "?" in the rendered PDF — included anyway
// since they're common requests, but this is a known, documented gap (see
// letterPdf.ts's font-routing comments) rather than silently pretended
// away.
const GROUPS: { label: string; chars: string[] }[] = [
  { label: 'Punctuation', chars: ['—', '–', '•', '…', '‘', '’', '“', '”', '¶', '§'] },
  { label: 'Currency', chars: ['€', '£', '¥', '¢', '₹'] },
  { label: 'Math', chars: ['±', '×', '÷', '≈', '≠', '≤', '≥', '°', '½', '¼', '¾'] },
  { label: 'Arrows / marks', chars: ['→', '←', '↑', '↓', '✓', '✗', '★'] },
  { label: 'Legal', chars: ['©', '®', '™'] },
];

export function SpecialCharPicker({ onPick }: { onPick: (ch: string) => void }) {
  return (
    <div className="absolute z-20 top-8 left-0 bg-surface-raised border border-border rounded-lg shadow-lg p-2 w-56 max-h-64 overflow-y-auto">
      {GROUPS.map((g) => (
        <div key={g.label} className="mb-1.5">
          <div className="text-[10px] font-semibold text-text-muted uppercase mb-0.5">{g.label}</div>
          <div className="flex flex-wrap gap-0.5">
            {g.chars.map((ch) => (
              <button
                key={ch}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(ch)}
                className="h-7 w-7 rounded hover:bg-surface-hover text-sm"
              >
                {ch}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
