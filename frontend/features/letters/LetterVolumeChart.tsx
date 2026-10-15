'use client';

// Split out of app/dashboard/page.tsx so recharts (statically imported here)
// can be loaded via next/dynamic({ ssr: false }) instead of shipping in the
// main dashboard bundle for every visit, including ones that never scroll to
// this widget.

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import {
  CHART_SERIES_COLORS,
  chartAxisTick,
  chartGridColor,
  chartLegendTextStyle,
  chartTooltipLabelStyle,
  chartTooltipStyle,
} from '../../shared/lib/chartTheme';
import type { LetterVolumeRow } from './types';

export default function LetterVolumeChart({ rows }: { rows: LetterVolumeRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={170}>
      <LineChart data={rows} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid stroke={chartGridColor} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="month"
          tick={chartAxisTick}
          axisLine={{ stroke: chartGridColor }}
          tickLine={false}
        />
        <YAxis
          tick={chartAxisTick}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
          width={28}
        />
        <Tooltip contentStyle={chartTooltipStyle} labelStyle={chartTooltipLabelStyle} />
        <Legend wrapperStyle={chartLegendTextStyle} iconType="circle" iconSize={8} />
        <Line
          type="monotone"
          dataKey="outgoing_count"
          name="Outgoing"
          stroke={CHART_SERIES_COLORS[0]}
          strokeWidth={2}
          dot={{ r: 3 }}
          activeDot={{ r: 4 }}
        />
        <Line
          type="monotone"
          dataKey="incoming_count"
          name="Incoming"
          stroke={CHART_SERIES_COLORS[1]}
          strokeWidth={2}
          dot={{ r: 3 }}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
