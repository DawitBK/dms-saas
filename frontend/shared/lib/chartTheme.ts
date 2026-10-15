/**
 * Shared recharts theming so every chart in the app (compliance reports,
 * dashboard widgets, …) reads as one system in both light and dark themes.
 *
 * Series colors are the app's own design tokens (brand / success / warning /
 * danger — see app/globals.css) rather than a generic palette, so charts
 * match badges, status pills, and the rest of the UI. The set has been
 * validated (categorical CVD-safe, ≥3:1 contrast) against both the light
 * (#ffffff) and dark (#0f172a) card surfaces without needing separate
 * light/dark variants.
 *
 * Chrome (grid/axis/tooltip) uses CSS custom properties directly so it
 * tracks theme switches (`ThemeSync` toggling `.dark` on <html>) live.
 */
import type { CSSProperties } from 'react';

/** Fixed-order categorical series colors — never cycle/reassign per filter. */
export const CHART_SERIES_COLORS = ['#6366f1', '#059669', '#d97706', '#f43f5e'] as const;

export const chartGridColor = 'var(--border)';

/**
 * recharts v3 types `XAxis`/`YAxis`'s `tick` prop as `TextProps`, which
 * (unlike the renderer's actual runtime behavior) does not declare `fill` or
 * `fontSize` — the standard `{ fill, fontSize }` styling object recharts
 * itself documents needs an escape hatch from that overly narrow type.
 * Kept as `any` in this one shared place so chart components stay fully typed.
 */
export const chartAxisTick: any = { fill: 'var(--text-muted)', fontSize: 11 };

export const chartTooltipStyle: CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--text-primary)',
  fontSize: 12,
  boxShadow: 'var(--shadow-md)',
  padding: '8px 10px',
};

export const chartTooltipLabelStyle: CSSProperties = {
  color: 'var(--text-secondary)',
  fontWeight: 600,
  marginBottom: 4,
};

export const chartLegendTextStyle: CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: 12,
};
