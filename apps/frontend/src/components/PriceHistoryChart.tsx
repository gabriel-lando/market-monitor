import { useMemo } from 'react';

import type { HistoryPoint } from '@market-monitor/shared';

import { formatCompactDate, formatCurrency, formatDateLabel } from '../lib/format.js';

export interface PriceHistorySeries {
  marketCode: string;
  marketName: string;
  color: string;
  points: HistoryPoint[];
}

interface PriceHistoryChartProps {
  ariaLabel: string;
  series: PriceHistorySeries[];
}

const CHART_WIDTH = 720;
const CHART_HEIGHT = 320;
const PADDING = { top: 20, right: 16, bottom: 34, left: 54 };

function parseDateOnlyTimestamp(value: string) {
  const normalized = value.trim();
  const datePart = normalized.includes('T') ? normalized.slice(0, 10) : normalized;
  const [yearText, monthText, dayText] = datePart.split('-');

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return Number.NaN;
  }

  return Date.UTC(year, month - 1, day);
}

function getPointTimestamp(point: HistoryPoint) {
  const snapshotDate = parseDateOnlyTimestamp(point.snapshot_date);
  if (!Number.isNaN(snapshotDate)) {
    return snapshotDate;
  }

  const capturedAtDate = parseDateOnlyTimestamp(point.captured_at);
  if (!Number.isNaN(capturedAtDate)) {
    return capturedAtDate;
  }

  return Date.parse(point.captured_at);
}

export function PriceHistoryChart({ ariaLabel, series }: PriceHistoryChartProps) {
  const computed = useMemo(() => {
    const normalizedSeries = series
      .map((entry) => ({
        ...entry,
        points: [...entry.points].sort((left, right) => getPointTimestamp(left) - getPointTimestamp(right)),
      }))
      .filter((entry) => entry.points.length > 0);

    const allPoints = normalizedSeries.flatMap((entry) => entry.points);
    if (allPoints.length === 0) {
      return null;
    }

    const timestamps = allPoints.map(getPointTimestamp);
    const prices = allPoints.map((point) => point.price_cents);

    let minX = Math.min(...timestamps);
    let maxX = Math.max(...timestamps);
    if (minX === maxX) {
      minX -= 1000 * 60 * 60 * 12;
      maxX += 1000 * 60 * 60 * 12;
    }

    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRange = Math.max(maxPrice - minPrice, 1);
    const paddedMinPrice = Math.max(0, minPrice - priceRange * 0.12);
    const paddedMaxPrice = maxPrice + priceRange * 0.12;

    const plotWidth = CHART_WIDTH - PADDING.left - PADDING.right;
    const plotHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;

    const scaleX = (value: number) => PADDING.left + ((value - minX) / (maxX - minX)) * plotWidth;
    const scaleY = (value: number) => PADDING.top + (1 - (value - paddedMinPrice) / (paddedMaxPrice - paddedMinPrice)) * plotHeight;

    const yTicks = Array.from({ length: 4 }, (_, index) => {
      const ratio = index / 3;
      const value = paddedMaxPrice - (paddedMaxPrice - paddedMinPrice) * ratio;
      return {
        value,
        y: scaleY(value),
      };
    });

    const xTickTimestamps = [minX, minX + (maxX - minX) / 2, maxX];
    const xTicks = xTickTimestamps.map((value) => ({
      value,
      x: scaleX(value),
      label: formatCompactDate(new Date(value).toISOString()),
    }));

    const renderedSeries = normalizedSeries.map((entry) => {
      const coordinates = entry.points.map((point) => ({
        point,
        x: scaleX(getPointTimestamp(point)),
        y: scaleY(point.price_cents),
      }));

      const path = coordinates.map((coordinate, index) => `${index === 0 ? 'M' : 'L'} ${coordinate.x.toFixed(2)} ${coordinate.y.toFixed(2)}`).join(' ');

      return {
        ...entry,
        coordinates,
        path,
      };
    });

    return {
      minDateLabel: formatDateLabel(new Date(minX).toISOString()),
      maxDateLabel: formatDateLabel(new Date(maxX).toISOString()),
      renderedSeries,
      xTicks,
      yTicks,
    };
  }, [series]);

  if (!computed) {
    return <div className="chart-empty">No history is available for this product yet.</div>;
  }

  return (
    <div className="chart-wrap">
      <div className="chart-canvas">
        <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label={ariaLabel}>
          <defs>
            <linearGradient id="chart-surface" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(255, 255, 255, 0.12)" />
              <stop offset="100%" stopColor="rgba(255, 255, 255, 0)" />
            </linearGradient>
          </defs>

          <rect x={PADDING.left} y={PADDING.top} width={CHART_WIDTH - PADDING.left - PADDING.right} height={CHART_HEIGHT - PADDING.top - PADDING.bottom} rx="22" fill="url(#chart-surface)" />

          {computed.yTicks.map((tick) => (
            <g key={tick.y}>
              <line x1={PADDING.left} y1={tick.y} x2={CHART_WIDTH - PADDING.right} y2={tick.y} className="chart-grid-line" />
              <text x={PADDING.left - 12} y={tick.y + 4} textAnchor="end" className="chart-axis-label">
                {formatCurrency(Math.round(tick.value), 'R$ 0,00')}
              </text>
            </g>
          ))}

          {computed.xTicks.map((tick) => (
            <text key={tick.x} x={tick.x} y={CHART_HEIGHT - 8} textAnchor="middle" className="chart-axis-label">
              {tick.label}
            </text>
          ))}

          {computed.renderedSeries.map((entry) => (
            <g key={entry.marketCode}>
              <path d={entry.path} fill="none" stroke={entry.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />

              {entry.coordinates.map((coordinate, index) => (
                <circle key={`${entry.marketCode}:${coordinate.point.captured_at}:${index}`} cx={coordinate.x} cy={coordinate.y} r={index === entry.coordinates.length - 1 ? 5 : 3} fill={entry.color} className="chart-point" />
              ))}
            </g>
          ))}
        </svg>
      </div>

      <div className="chart-caption">
        <span>
          {computed.renderedSeries.length} tracked market{computed.renderedSeries.length === 1 ? '' : 's'}
        </span>
        <span>
          {computed.minDateLabel} to {computed.maxDateLabel}
        </span>
      </div>
    </div>
  );
}
