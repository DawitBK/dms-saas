'use client';

import { useState } from 'react';

const MAX = 8;

/** The classic "hover a grid to pick rows×cols" table-insert control. */
export function TableGridPicker({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const [hover, setHover] = useState({ row: 0, col: 0 });
  return (
    <div className="absolute z-20 top-8 left-0 bg-surface-raised border border-border rounded-lg shadow-lg p-2">
      <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${MAX}, 16px)` }}>
        {Array.from({ length: MAX * MAX }, (_, i) => {
          const row = Math.floor(i / MAX) + 1;
          const col = (i % MAX) + 1;
          const active = row <= hover.row && col <= hover.col;
          return (
            <button
              key={i}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHover({ row, col })}
              onClick={() => onPick(row, col)}
              className={`h-4 w-4 border ${active ? 'bg-brand-200 border-brand-400' : 'bg-surface-base border-border'}`}
            />
          );
        })}
      </div>
      <div className="text-center text-xs text-text-muted mt-1">
        {hover.row || 1} × {hover.col || 1}
      </div>
    </div>
  );
}
