'use client';

// recharts is statically imported here and loaded via next/dynamic({ ssr:
// false }) from app/dashboard/reports/page.tsx — same pattern as
// ComplianceReportChart.tsx / LetterVolumeChart.tsx — so the library never
// ships in a bundle for a visit that doesn't open the Reports dashboard.

import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  CHART_SERIES_COLORS,
  chartAxisTick,
  chartGridColor,
  chartLegendTextStyle,
  chartTooltipLabelStyle,
  chartTooltipStyle,
} from '../../shared/lib/chartTheme';

// ─── Trend (documents created per day, zero-filled) ──────────────────────────

export interface TrendPoint {
  date: string;
  count: number;
}

export function TrendAreaChart({ data }: { data: TrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 4 }}>
        <defs>
          <linearGradient id="dms-trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART_SERIES_COLORS[0]} stopOpacity={0.35} />
            <stop offset="100%" stopColor={CHART_SERIES_COLORS[0]} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={chartGridColor} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="date"
          tick={chartAxisTick}
          axisLine={{ stroke: chartGridColor }}
          tickLine={false}
          minTickGap={24}
          tickFormatter={(v: string) => v.slice(5)}
        />
        <YAxis tick={chartAxisTick} axisLine={false} tickLine={false} allowDecimals={false} width={32} />
        <Tooltip
          contentStyle={chartTooltipStyle}
          labelStyle={chartTooltipLabelStyle}
          cursor={{ stroke: chartGridColor }}
          formatter={((value: unknown) => [value as number, 'Documents']) as any}
        />
        <Area
          type="monotone"
          dataKey="count"
          name="Documents created"
          stroke={CHART_SERIES_COLORS[0]}
          strokeWidth={2}
          fill="url(#dms-trend-fill)"
          dot={false}
          activeDot={{ r: 4 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── Distribution bar (by department / by document type) ─────────────────────
// Single-series magnitude ranking — one hue (the app's primary brand series
// color), not a categorical rainbow: the identity axis here is the category
// label itself, already legible on the axis, so color would only encode rank.

export interface DistributionRow {
  code: string;
  name: string;
  count: number;
}

export function DistributionBarChart({ data }: { data: DistributionRow[] }) {
  const manyCategories = data.length > 5;
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: manyCategories ? 40 : 8 }}>
        <CartesianGrid stroke={chartGridColor} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="name"
          tick={chartAxisTick}
          axisLine={{ stroke: chartGridColor }}
          tickLine={false}
          interval={0}
          angle={manyCategories ? -25 : 0}
          textAnchor={manyCategories ? 'end' : 'middle'}
          height={manyCategories ? 56 : 30}
          tickFormatter={(v: string) => (v && v.length > 14 ? `${v.slice(0, 13)}…` : v)}
        />
        <YAxis tick={chartAxisTick} axisLine={false} tickLine={false} allowDecimals={false} width={32} />
        <Tooltip
          contentStyle={chartTooltipStyle}
          labelStyle={chartTooltipLabelStyle}
          cursor={{ fill: 'var(--surface-raised)' }}
          formatter={((value: unknown) => [value as number, 'Documents']) as any}
        />
        <Bar dataKey="count" name="Documents" fill={CHART_SERIES_COLORS[0]} radius={[4, 4, 0, 0]} maxBarSize={56} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Category donut (by status / by classification) ──────────────────────────
// Identity encoding across many possible categories — colors are assigned by
// entity (via colorFor), not by rank, and slices beyond the top N fold into a
// neutral "Other" bucket rather than spawning more categorical hues.

export interface CategoryRow {
  key: string;
  label: string;
  count: number;
}

const MAX_SLICES = 7;
const OTHER_COLOR = '#94a3b8';

export function CategoryDonutChart({
  data,
  colorFor,
}: {
  data: CategoryRow[];
  colorFor: (key: string) => string;
}) {
  const { slices, total } = useMemo(() => {
    const sorted = [...data].filter((d) => d.count > 0).sort((a, b) => b.count - a.count);
    const head = sorted.slice(0, MAX_SLICES);
    const rest = sorted.slice(MAX_SLICES);
    const restTotal = rest.reduce((s, r) => s + r.count, 0);
    const slices = restTotal > 0 ? [...head, { key: '__other__', label: 'Other', count: restTotal }] : head;
    const total = slices.reduce((s, r) => s + r.count, 0);
    return { slices, total };
  }, [data]);

  if (total === 0) {
    return (
      <div className="flex items-center justify-center h-[220px] text-sm" style={{ color: 'var(--text-muted)' }}>
        No data for the current filters
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <Pie
          data={slices}
          dataKey="count"
          nameKey="label"
          innerRadius="55%"
          outerRadius="85%"
          paddingAngle={2}
          strokeWidth={2}
          stroke="var(--surface-card)"
        >
          {slices.map((s) => (
            <Cell key={s.key} fill={s.key === '__other__' ? OTHER_COLOR : colorFor(s.key)} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={chartTooltipStyle}
          labelStyle={chartTooltipLabelStyle}
          formatter={
            ((value: unknown, _name: unknown, entry: any) => [
              `${value} (${(((value as number) / total) * 100).toFixed(0)}%)`,
              entry?.payload?.label,
            ]) as any
          }
        />
        <Legend
          wrapperStyle={chartLegendTextStyle}
          iconType="circle"
          iconSize={8}
          layout="vertical"
          verticalAlign="middle"
          align="right"
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
