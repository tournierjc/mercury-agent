import { useMemo } from "react";
import { CodeBlock } from "./CodeBlock";
import { cn } from "@/lib/utils";
import { OPENUI_FENCE, parseOpenUi, type OpenUiNode } from "@/lib/openui";

interface OpenUiBlockProps {
  spec: string;
  className?: string;
}

/**
 * A rendered `openui` block — the web half of the contract the `openui-contract`
 * Mercury plugin enforces (`CONTRACT.md`).
 *
 * It draws only from `OpenUiNode`: the parser has already refused URLs, scripts and
 * unknown components, so nothing here has to be suspicious of its input. A spec that
 * fails to parse is shown as code with the first reason — a message is never lost,
 * it is just not drawn.
 */
export function OpenUiBlock({ spec, className }: OpenUiBlockProps) {
  const result = useMemo(() => parseOpenUi(spec), [spec]);

  if (!result.ok) {
    return (
      <div className={cn("my-3", className)}>
        <div className="rounded-lg border border-border bg-card/60 px-3 py-2 text-[11px] text-muted-foreground">
          <span className="font-mono text-foreground/70">{OPENUI_FENCE}</span> — not rendered:{" "}
          {result.errors[0]}
        </div>
        <CodeBlock code={spec} language={OPENUI_FENCE} />
      </div>
    );
  }

  return (
    <div className={cn("my-3 flex flex-col gap-2.5", className)}>
      <NodeView node={result.root} />
    </div>
  );
}

const TONE_STRIPE: Record<string, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  danger: "bg-destructive",
};

const TONE_TEXT: Record<string, string> = {
  ok: "text-success",
  warn: "text-warning",
  danger: "text-destructive",
};

function NodeView({ node }: { node: OpenUiNode }) {
  switch (node.type) {
    case "Stack":
      return (
        <div className="flex flex-col gap-2.5">
          {node.children.map((child, index) => (
            <NodeView key={index} node={child} />
          ))}
        </div>
      );

    case "Paragraph": {
      const style =
        node.variant === "h1"
          ? "text-lg font-semibold tracking-tight"
          : node.variant === "h2" || node.variant === "h3"
            ? "text-base font-semibold tracking-tight"
            : node.variant === "mono"
              ? "font-mono text-[0.8125rem]"
              : "text-sm leading-relaxed";
      return <p className={cn(style, node.muted ? "text-muted-foreground" : "text-foreground")}>{node.text}</p>;
    }

    case "Card": {
      const stripe = TONE_STRIPE[node.tone];
      return (
        <div className="flex overflow-hidden rounded-lg border border-border bg-card/60">
          {stripe ? <div className={cn("w-[3px] shrink-0", stripe)} /> : null}
          <div className="px-3.5 py-3">
            {node.title ? <div className="text-sm font-semibold text-foreground">{node.title}</div> : null}
            {node.body ? <div className="mt-1 text-[0.8125rem] text-muted-foreground">{node.body}</div> : null}
          </div>
        </div>
      );
    }

    case "KeyValue":
      return (
        <div className="flex items-baseline justify-between gap-4 border-b border-border/70 py-2 last:border-b-0">
          <span className="text-[0.8125rem] text-muted-foreground">{node.label}</span>
          <span
            className={cn(
              "text-[0.8125rem] tabular-nums",
              node.highlight ? "font-semibold text-mercury-500" : "text-foreground",
            )}
          >
            {node.value}
          </span>
        </div>
      );

    case "Table": {
      // A column of numbers reads better right-aligned; the rule is the data, not the header.
      const numeric = node.columns.map(
        (_, index) =>
          node.rows.length > 0 && node.rows.every((row) => /^-?\d+([.,]\d+)?$/.test((row[index] ?? "").trim())),
      );
      return (
        <div className="overflow-x-auto rounded-lg border border-border bg-card/60 px-3 py-2.5">
          {node.caption ? <div className="mb-2 text-[11px] text-muted-foreground">{node.caption}</div> : null}
          <table className="w-full border-collapse text-[0.8125rem]">
            <thead>
              <tr>
                {node.columns.map((title, index) => (
                  <th
                    key={index}
                    className={cn(
                      "border-b border-border px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
                      numeric[index] ? "text-right" : "text-left",
                    )}
                  >
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="even:bg-white/[0.015]">
                  {node.columns.map((_, cellIndex) => (
                    <td
                      key={cellIndex}
                      className={cn(
                        "border-b border-border/60 px-2 py-1.5 text-foreground last:border-b-0",
                        numeric[cellIndex] ? "text-right tabular-nums" : "text-left",
                      )}
                    >
                      {row[cellIndex] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case "Bullets": {
      const Tag = node.ordered ? "ol" : "ul";
      return (
        <Tag className={cn("pl-5 text-[0.8125rem] leading-relaxed text-foreground", node.ordered ? "list-decimal" : "list-disc")}>
          {node.items.map((item, index) => (
            <li key={index} className="py-0.5">
              {item}
            </li>
          ))}
        </Tag>
      );
    }

    case "Stat":
      return (
        <div className="rounded-lg border border-border bg-card/60 px-3.5 py-3">
          <div className="flex items-baseline gap-2">
            <span className={cn("text-2xl font-bold tabular-nums", TONE_TEXT[node.tone] ?? "text-foreground")}>
              {node.value}
            </span>
            {node.delta ? <span className="text-xs text-muted-foreground">{node.delta}</span> : null}
          </div>
          <div className="text-xs text-muted-foreground">{node.label}</div>
        </div>
      );

    case "Snippet":
      return (
        <div>
          {node.title ? <div className="mb-1 text-[11px] text-muted-foreground">{node.title}</div> : null}
          <CodeBlock code={node.code} language={node.language} />
        </div>
      );

    case "Chart":
      return <ChartView node={node} />;
  }
}

/** Round tick steps (1, 2, 5 × 10^k): labels read 0/5/10, never 0/2/5/7/9. */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const fraction = raw / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

function ChartView({ node }: { node: Extract<OpenUiNode, { type: "Chart" }> }) {
  const width = 640;
  const height = 170;
  // Right padding leaves room for the last x label: a centred "12:00" at the plot edge
  // was being clipped to "12:0".
  const pad = { top: 10, right: 16, bottom: 22, left: 40 };
  const dataMax = Math.max(...node.values, 1);
  const step = niceStep(Math.max(dataMax / 4, 1));
  const max = Math.ceil(dataMax / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + 1e-9; value += step) ticks.push(value);

  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const y = (value: number) => pad.top + (1 - value / max) * plotHeight;
  const slot = plotWidth / Math.max(node.values.length, 1);
  const barWidth = Math.min(38, slot * 0.55);

  return (
    <div className="rounded-lg border border-border bg-card/60 px-3.5 py-3">
      {node.title ? <div className="text-sm font-semibold text-foreground">{node.title}</div> : null}
      {node.unit ? <div className="mb-1 text-[11px] text-muted-foreground">in {node.unit}</div> : null}
      <svg viewBox={`0 0 ${width} ${height}`} className="mt-2 w-full" role="img" aria-label={node.title ?? "chart"}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke="currentColor" className="text-border" strokeWidth={1} />
            <text x={pad.left - 8} y={y(tick) + 3.5} textAnchor="end" className="fill-muted-foreground font-mono text-[10px]">
              {Math.round(tick)}
            </text>
          </g>
        ))}
        {node.kind === "bar"
          ? node.values.map((value, index) => {
              const left = pad.left + slot * index + (slot - barWidth) / 2;
              const top = y(value);
              return (
                <rect
                  key={index}
                  x={left}
                  y={top}
                  width={barWidth}
                  height={Math.max(1, pad.top + plotHeight - top)}
                  rx={4}
                  className="fill-mercury-500"
                />
              );
            })
          : (() => {
              const points = node.values
                .map((value, index) => {
                  const x = node.values.length === 1 ? pad.left + plotWidth / 2 : pad.left + (plotWidth / (node.values.length - 1)) * index;
                  return `${x},${y(value)}`;
                })
                .join(" ");
              return (
                <>
                  <polyline points={points} fill="none" className="stroke-mercury-500" strokeWidth={2} strokeLinejoin="round" />
                  {node.values.map((value, index) => {
                    const x = node.values.length === 1 ? pad.left + plotWidth / 2 : pad.left + (plotWidth / (node.values.length - 1)) * index;
                    return <circle key={index} cx={x} cy={y(value)} r={3.5} className="fill-card stroke-mercury-500" strokeWidth={2} />;
                  })}
                </>
              );
            })()}
        {node.labels.map((label, index) => {
          const x =
            node.kind === "bar"
              ? pad.left + slot * index + slot / 2
              : node.values.length === 1
                ? pad.left + plotWidth / 2
                : pad.left + (plotWidth / (node.values.length - 1)) * index;
          // The first and last labels hug the plot edge instead of centring on it,
          // otherwise half of them is drawn outside the viewBox.
          const anchor = index === 0 ? "start" : index === node.labels.length - 1 ? "end" : "middle";
          return (
            <text key={index} x={x} y={height - 6} textAnchor={anchor} className="fill-muted-foreground font-mono text-[10px]">
              {label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
