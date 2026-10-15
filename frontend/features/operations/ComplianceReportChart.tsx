'use client';

// Split out of ComplianceReportsPanel.tsx so recharts (statically imported
// here) can be loaded via next/dynamic({ ssr: false }) instead of shipping in
// the main operations bundle for every visit, including ones that never open
// the Reports panel.

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
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

export interface ChartSeries {
  categoryKey: string;
  series: { key: string; label: string }[];
}

export default function ComplianceReportChart({
  rows,
  chart,
  manyCategories,
}: {
  rows: Record<string, unknown>[];
  chart: ChartSeries;
  manyCategories: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={rows} margin={{ top: 4, right: 8, left: -12, bottom: manyCategories ? 28 : 4 }}>
        <CartesianGrid stroke={chartGridColor} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey={chart.categoryKey}
          tick={chartAxisTick}
          axisLine={{ stroke: chartGridColor }}
          tickLine={false}
          interval={0}
          angle={manyCategories ? -20 : 0}
          textAnchor={manyCategories ? 'end' : 'middle'}
          height={manyCategories ? 46 : 28}
          tickFormatter={(v: string) => (v && v.length > 16 ? `${v.slice(0, 15)}…` : v)}
        />
        <YAxis tick={chartAxisTick} axisLine={false} tickLine={false} allowDecimals={false} width={32} />
        <Tooltip
          contentStyle={chartTooltipStyle}
          labelStyle={chartTooltipLabelStyle}
          cursor={{ fill: 'var(--surface-raised)' }}
        />
        {chart.series.length > 1 && (
          <Legend wrapperStyle={chartLegendTextStyle} iconType="circle" iconSize={8} />
        )}
        {chart.series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={CHART_SERIES_COLORS[i % CHART_SERIES_COLORS.length]}
            radius={[4, 4, 0, 0]}
            maxBarSize={48}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
