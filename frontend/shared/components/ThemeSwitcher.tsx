'use client';

import { useThemeStore, type Theme } from '../../state/theme.store';
import { cn } from '../lib/cn';

const THEMES: {
  value: Theme;
  label: string;
  style: React.CSSProperties;
  ring: string;
}[] = [
  {
    value: 'light',
    label: 'Light',
    style: { background: '#ffffff', border: '2px solid #cbd5e1' },
    ring: '#94a3b8',
  },
  {
    value: 'dark-blue',
    label: 'Blue',
    style: { background: '#0a1628', border: '2px solid #1e3a5f' },
    ring: '#6366f1',
  },
  {
    value: 'dark-black',
    label: 'Black',
    style: { background: '#0a0a0a', border: '2px solid #333' },
    ring: '#64748b',
  },
];

interface ThemeSwitcherProps {
  showLabel?: boolean;
}

export function ThemeSwitcher({ showLabel = false }: ThemeSwitcherProps) {
  const { theme, setTheme } = useThemeStore();

  return (
    <div className="flex items-center gap-2.5">
      {showLabel && (
        <span
          className="text-[10px] font-bold uppercase tracking-widest flex-1"
          style={{ color: 'var(--sidebar-text)' }}
        >
          Theme
        </span>
      )}
      <div className="flex items-center gap-1.5">
        {THEMES.map((t) => (
          <button
            key={t.value}
            onClick={() => setTheme(t.value)}
            title={t.label}
            aria-label={`${t.label} theme`}
            className={cn(
              'rounded-full transition-all',
              theme === t.value ? 'scale-110' : 'opacity-50 hover:opacity-80',
            )}
            style={{
              width: 20,
              height: 20,
              ...t.style,
              boxShadow:
                theme === t.value
                  ? `0 0 0 2px var(--sidebar-bg), 0 0 0 3.5px ${t.ring}`
                  : '0 0 0 1px rgba(255,255,255,0.15)',
            }}
          />
        ))}
      </div>
    </div>
  );
}
