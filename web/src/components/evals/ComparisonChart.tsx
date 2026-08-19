import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EvalRun } from "../../types";
import {
  CHART_METRICS,
  clampTooltip,
  formatPercent,
  formatSeconds,
  paretoFrontier,
  type ChartMetric,
  type ParetoPoint,
  type RunSummary,
} from "./evalMath";

// The one picture the comparison exists for (plan 009): quality on y, price
// (or latency, or tokens) on x, so "up and to the left is better" and the
// Pareto frontier is the shortlist. One series, one hue: identity is carried
// by the direct label on every dot, never by colour, which is also why a
// six-run chart does not run into the categorical palette's three-slot cap for
// scatter forms.

interface ComparisonChartProps {
  rows: Array<{ run: EvalRun; summary: RunSummary }>;
  baselineId: string;
  metric: ChartMetric;
  onMetricChange: (metric: ChartMetric) => void;
}

const HEIGHT = 296;
const MARGIN = { top: 18, right: 18, bottom: 46, left: 56 };
// Chart surface is the white panel; these mirror the page's ink and hairline
// colours so the plot chrome recedes the way the rest of the app does.
const SERIES = "#2a78d6";
const GRID = "#e6e8ec";
const AXIS = "#c8cdd4";
const INK_MUTED = "#8a919c";
const INK_SECONDARY = "#565f6d";

interface PlottedRun {
  run: EvalRun;
  summary: RunSummary;
  x: number;
  y: number;
  cx: number;
  cy: number;
  r: number;
  onFrontier: boolean;
  isBaseline: boolean;
  // True when this run covers fewer scenarios than the widest selected run
  // (a subset run, or one that died partway). Its pass rate is over its own
  // scenarios only, so the dot is drawn dashed and the tooltip says so
  // rather than letting 16/16 read as the equal of 19/19.
  partial: boolean;
}

// Round an axis maximum up to 1/2/5 x a power of ten, so ticks land on values
// a reader can do arithmetic with ($0.40, not $0.3711).
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 10].find((candidate) => normalized <= candidate) ?? 10;
  return step * magnitude;
}

// Direct labels, placed to the right of their dot and flipped to the left when
// that would overflow the plot, then nudged vertically until no two label boxes
// overlap. Approximate glyph width is fine here: the boxes only have to be
// close enough to stop labels colliding, and the tooltip carries the detail.
const LABEL_HEIGHT = 13;
const CHAR_WIDTH = 6.1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface PlacedLabel {
  text: string;
  x: number;
  y: number;
  anchor: "start" | "end";
}

function placeLabels(points: PlottedRun[], plotRight: number, plotTop: number, plotBottom: number): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  // The dots are obstacles too, not just the other labels: a name laid across
  // a neighbouring marker is as unreadable as one laid across another name.
  const boxes: Array<{ left: number; right: number; top: number; bottom: number }> = points.map((p) => ({
    left: p.cx - p.r - 3,
    right: p.cx + p.r + 3,
    top: p.cy - p.r - 3,
    bottom: p.cy + p.r + 3,
  }));
  // Left to right, so a label that has to move sees the ones already settled.
  const ordered = [...points].sort((a, b) => a.cx - b.cx || a.cy - b.cy);
  for (const point of ordered) {
    const width = point.run.label.length * CHAR_WIDTH;
    const fitsRight = point.cx + point.r + 6 + width <= plotRight;
    const anchor: "start" | "end" = fitsRight ? "start" : "end";
    const x = fitsRight ? point.cx + point.r + 6 : point.cx - point.r - 6;
    const left = fitsRight ? x : x - width;
    let y = clamp(point.cy + 4, plotTop + LABEL_HEIGHT, plotBottom);
    for (let attempt = 1; attempt <= 24; attempt += 1) {
      const box = { left, right: left + width, top: y - LABEL_HEIGHT, bottom: y };
      const clash = boxes.some((b) => !(box.right < b.left || box.left > b.right || box.bottom < b.top || box.top > b.bottom));
      if (!clash) break;
      // Alternate above and below the first choice so a cluster fans out
      // rather than marching off one edge of the plot. Each candidate is
      // clamped into the plot before it is tested, so a run of points along
      // the top of the chart (every model at 100%) cannot be pushed out of
      // bounds and then clamped back on top of each other.
      const step = Math.ceil(attempt / 2) * (LABEL_HEIGHT + 2);
      y = clamp(point.cy + 4 + (attempt % 2 === 1 ? -step : step), plotTop + LABEL_HEIGHT, plotBottom);
    }
    boxes.push({ left, right: left + width, top: y - LABEL_HEIGHT, bottom: y });
    placed.push({ text: point.run.label, x, y, anchor });
  }
  return placed;
}

export function ComparisonChart({ rows, baselineId, metric, onMetricChange }: ComparisonChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The tooltip is anchored to the panel rather than to the plot frame: the
  // frame scrolls horizontally, and an overflow-x frame also clips vertically,
  // which cropped the readout for any dot near the top of the plot.
  const panelRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(760);
  const [hovered, setHovered] = useState<string | null>(null);
  const [hoverAt, setHoverAt] = useState<{ left: number; top: number } | null>(null);

  // The SVG is drawn in real pixels rather than a scaled viewBox so the HTML
  // tooltip can be positioned from the same coordinates the dots use, and so
  // the label text never scales away on a narrow viewport.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.max(420, entry.contentRect.width));
    });
    observer.observe(element);
    setWidth(Math.max(420, element.clientWidth));
    return () => observer.disconnect();
  }, []);

  const metricDef = CHART_METRICS.find((m) => m.key === metric) ?? CHART_METRICS[0]!;

  const plottable = rows.filter((row) => metricDef.getValue(row.summary) !== null);
  const excluded = rows.filter((row) => metricDef.getValue(row.summary) === null);

  // Hovering a dot that then leaves the plot (metric switched, run deselected)
  // would strand the tooltip, so the hover is cleared whenever the plotted set
  // changes rather than only on pointer-out.
  const plottedKey = plottable.map((row) => row.run.runId).join(",");
  useEffect(() => {
    setHovered(null);
    setHoverAt(null);
  }, [plottedKey, metric]);

  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;

  const rawMax = Math.max(...plottable.map((row) => metricDef.getValue(row.summary) ?? 0), 0);
  const xMax = niceCeil(rawMax > 0 ? rawMax : 1);
  const maxLatency = Math.max(...rows.map((row) => row.summary.meanLatencyMs ?? 0), 1);
  const maxTotal = Math.max(...rows.map((row) => row.summary.total), 0);

  const frontier = paretoFrontier(
    plottable.map<ParetoPoint>((row) => ({
      id: row.run.runId,
      x: metricDef.getValue(row.summary) ?? 0,
      y: row.summary.passRate,
    })),
  );

  const points: PlottedRun[] = plottable.map((row) => {
    const x = metricDef.getValue(row.summary) ?? 0;
    const y = row.summary.passRate;
    // Area, not radius, carries latency: doubling the radius would quadruple
    // the ink for a doubled number.
    const latencyShare = (row.summary.meanLatencyMs ?? 0) / maxLatency;
    return {
      run: row.run,
      summary: row.summary,
      x,
      y,
      cx: MARGIN.left + (x / xMax) * plotWidth,
      cy: MARGIN.top + (1 - y) * plotHeight,
      r: 5 + 8 * Math.sqrt(Math.max(0, latencyShare)),
      onFrontier: frontier.has(row.run.runId),
      isBaseline: row.run.runId === baselineId,
      partial: row.summary.total < maxTotal,
    };
  });

  const labels = placeLabels(points, MARGIN.left + plotWidth, MARGIN.top, MARGIN.top + plotHeight);
  const frontierPoints = points.filter((p) => p.onFrontier).sort((a, b) => a.x - b.x || b.y - a.y);
  // Staircase, not a straight join: between two frontier runs the best quality
  // your budget buys is still the cheaper run's, so the line holds flat and
  // then steps up at the price where the better run starts.
  const frontierPath = frontierPoints
    .map((p, i) => (i === 0 ? `M ${p.cx.toFixed(1)} ${p.cy.toFixed(1)}` : `H ${p.cx.toFixed(1)} V ${p.cy.toFixed(1)}`))
    .join(" ");

  function show(target: SVGGElement, runId: string) {
    const panel = panelRef.current;
    if (!panel) return;
    const mark = target.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    setHovered(runId);
    // The <g> box is the hit area, so its own top is well above the painted
    // dot; the tooltip is offset from the mark's centre instead.
    setHoverAt({ left: clampTooltip(mark.left - box.left + mark.width / 2, box.width), top: mark.top - box.top + mark.height / 2 });
  }

  function hide(runId: string) {
    setHovered((current) => (current === runId ? null : current));
    setHoverAt((current) => (hovered === runId ? null : current));
  }

  const hoveredPoint = points.find((p) => p.run.runId === hovered) ?? null;
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * xMax);
  const yTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <section className="panel evals-chart-panel" ref={panelRef}>
      <div className="evals-panel-head">
        <h2>Quality against {metricDef.label.toLowerCase()}</h2>
        <div className="evals-metric-switch" role="group" aria-label="Chart x axis metric">
          {CHART_METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              className={m.key === metric ? "evals-metric-switch-active" : undefined}
              aria-pressed={m.key === metric}
              onClick={() => onMetricChange(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="evals-chart-frame" ref={containerRef}>
        <svg width={width} height={HEIGHT} role="img" aria-label={`Pass rate against ${metricDef.axisLabel} for each selected run`}>
          {yTicks.map((t) => {
            const y = MARGIN.top + (1 - t) * plotHeight;
            return (
              <g key={`y-${t}`}>
                <line x1={MARGIN.left} x2={MARGIN.left + plotWidth} y1={y} y2={y} stroke={GRID} strokeWidth={1} />
                <text x={MARGIN.left - 10} y={y + 4} textAnchor="end" fontSize={11} fill={INK_MUTED}>
                  {formatPercent(t)}
                </text>
              </g>
            );
          })}
          {xTicks.map((t, i) => {
            const x = MARGIN.left + (t / xMax) * plotWidth;
            return (
              <text key={`x-${i}`} x={x} y={MARGIN.top + plotHeight + 18} textAnchor="middle" fontSize={11} fill={INK_MUTED}>
                {metricDef.formatTick(t)}
              </text>
            );
          })}
          <line
            x1={MARGIN.left}
            x2={MARGIN.left + plotWidth}
            y1={MARGIN.top + plotHeight}
            y2={MARGIN.top + plotHeight}
            stroke={AXIS}
            strokeWidth={1}
          />
          <text x={MARGIN.left + plotWidth / 2} y={HEIGHT - 8} textAnchor="middle" fontSize={11} fill={INK_SECONDARY}>
            {metricDef.axisLabel}, lower is better
          </text>
          <text
            transform={`translate(14 ${MARGIN.top + plotHeight / 2}) rotate(-90)`}
            textAnchor="middle"
            fontSize={11}
            fill={INK_SECONDARY}
          >
            Pass rate
          </text>

          {frontierPoints.length > 1 && (
            <path d={frontierPath} fill="none" stroke={SERIES} strokeWidth={2} strokeOpacity={0.35} strokeLinejoin="round" />
          )}

          {points.map((p) => (
            <g
              key={p.run.runId}
              tabIndex={0}
              role="img"
              aria-label={`${p.run.label}: ${formatPercent(p.y)} pass rate over ${p.summary.total} scenarios, ${metricDef.label.toLowerCase()} ${metricDef.format(p.x)}, mean latency ${formatSeconds(p.summary.meanLatencyMs)}${p.onFrontier ? ", on the frontier" : ""}${p.partial ? ", partial coverage" : ""}`}
              className="evals-chart-point"
              onMouseEnter={(e) => show(e.currentTarget, p.run.runId)}
              onMouseLeave={() => hide(p.run.runId)}
              onFocus={(e) => show(e.currentTarget, p.run.runId)}
              onBlur={() => hide(p.run.runId)}
            >
              {/* Hit target, not a mark: a 12px dot is a pinpoint, so every
                  point owns at least 24px of pointer and focus area. */}
              <circle cx={p.cx} cy={p.cy} r={Math.max(14, p.r + 8)} fill="transparent" />
              {p.isBaseline && <circle cx={p.cx} cy={p.cy} r={p.r + 4} fill="none" stroke={SERIES} strokeWidth={1} strokeOpacity={0.45} />}
              <circle
                cx={p.cx}
                cy={p.cy}
                r={p.r}
                fill={p.onFrontier ? SERIES : "#ffffff"}
                stroke={SERIES}
                strokeWidth={2}
                strokeDasharray={p.partial ? "3 2" : undefined}
                fillOpacity={p.onFrontier ? 0.9 : 1}
              />
              {p.run.runId === hovered && <circle cx={p.cx} cy={p.cy} r={p.r + 2} fill="none" stroke="#ffffff" strokeWidth={2} />}
            </g>
          ))}

          {labels.map((label) => (
            <text
              key={label.text}
              x={label.x}
              y={label.y}
              textAnchor={label.anchor}
              fontSize={11}
              fontWeight={600}
              fill={INK_SECONDARY}
              pointerEvents="none"
            >
              {label.text}
            </text>
          ))}
        </svg>

      </div>

      {hoveredPoint && hoverAt && (
        <div
          className="evals-chart-tooltip"
          style={{
            left: `${hoverAt.left}px`,
            top: `${hoverAt.top - hoveredPoint.r}px`,
          }}
        >
          <div className="evals-chart-tooltip-value">{formatPercent(hoveredPoint.y)} pass rate</div>
          <div className="evals-chart-tooltip-label">{hoveredPoint.run.label}</div>
          <dl className="evals-chart-tooltip-rows">
            <div>
              <dt>{metricDef.label}</dt>
              <dd>{metricDef.format(hoveredPoint.x)}</dd>
            </div>
            <div>
              <dt>Mean latency</dt>
              <dd>{formatSeconds(hoveredPoint.summary.meanLatencyMs)}</dd>
            </div>
            <div>
              <dt>Scenarios</dt>
              <dd>
                {hoveredPoint.summary.pass}/{hoveredPoint.summary.total} passing
              </dd>
            </div>
          </dl>
          {hoveredPoint.partial && (
            <div className="evals-chart-tooltip-tag">
              Covers {hoveredPoint.summary.total} of {maxTotal} scenarios, so this rate is not over the same suite
            </div>
          )}
          {hoveredPoint.onFrontier && <div className="evals-chart-tooltip-tag">No selected run beats it on both axes</div>}
        </div>
      )}

      <div className="evals-chart-legend">
        <span className="evals-chart-key">
          <svg width={14} height={14} aria-hidden="true">
            <circle cx={7} cy={7} r={5} fill={SERIES} fillOpacity={0.9} stroke={SERIES} strokeWidth={2} />
          </svg>
          on the frontier
        </span>
        <span className="evals-chart-key">
          <svg width={14} height={14} aria-hidden="true">
            <circle cx={7} cy={7} r={5} fill="#ffffff" stroke={SERIES} strokeWidth={2} />
          </svg>
          beaten on both axes
        </span>
        <span className="evals-chart-key">
          <svg width={20} height={14} aria-hidden="true">
            <circle cx={5} cy={7} r={3} fill="none" stroke={SERIES} strokeWidth={1.5} />
            <circle cx={14} cy={7} r={5} fill="none" stroke={SERIES} strokeWidth={1.5} />
          </svg>
          marker size is mean latency
        </span>
      </div>

      {excluded.length > 0 && (
        <p className="evals-chart-note">
          Not plotted (no {metricDef.label.toLowerCase()} recorded): {excluded.map((row) => row.run.label).join(", ")}. Switch the axis
          above, or see the table view below for what these runs do have.
        </p>
      )}
    </section>
  );
}
