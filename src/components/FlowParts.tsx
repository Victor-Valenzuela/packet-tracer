import {
  BaseEdge,
  EdgeLabelRenderer,
  getStraightPath,
  Handle,
  Position,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { isL3Switch, modelById } from "../lib/catalog";
import type { Device, DeviceKind } from "../lib/types";

export type DevNode = Node<{ device: Device }, "device">;
export type LinkEdgeT = Edge<{ aLabel: string; bLabel: string; net?: string; wireless?: boolean; wifi?: string }, "link">;

const COLORS: Record<DeviceKind, string> = {
  router: "#3b82f6",
  switch: "#10b981",
  pc: "#a78bfa",
  server: "#f59e0b",
  internet: "#38bdf8",
  ap: "#f472b6",
  wrouter: "#f472b6",
};

const L3_COLOR = "#22d3ee";

export function KindIcon({ kind, size = 36, l3 = false }: { kind: DeviceKind; size?: number; l3?: boolean }) {
  const c = l3 ? L3_COLOR : COLORS[kind];
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: c, strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (kind === "router")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 6v12M6 12h12M9.5 8.5 12 6l2.5 2.5M9.5 15.5 12 18l2.5-2.5M8.5 9.5 6 12l2.5 2.5M15.5 9.5 18 12l-2.5 2.5" />
      </svg>
    );
  if (kind === "switch")
    return (
      <svg {...common}>
        <rect x="2.5" y="8" width="19" height="8" rx="1.5" />
        <path d="M6 12h.01M9 12h.01M12 12h.01M15 12h.01M18 12h.01" />
        <path d="M7 5.5h3M14 5.5h3M7 18.5h3M14 18.5h3" opacity=".5" />
        {l3 && (
          <text x="12" y="22.5" textAnchor="middle" fontSize="5.5" fontWeight="700" fill={c} stroke="none">
            L3
          </text>
        )}
      </svg>
    );
  if (kind === "ap" || kind === "wrouter")
    return (
      <svg {...common}>
        <path d="M5 9.5a10 10 0 0 1 14 0M8 12.5a6 6 0 0 1 8 0" />
        <circle cx="12" cy="15.5" r="1" />
        <rect x="6" y="18" width="12" height="3.5" rx="1" />
      </svg>
    );
  if (kind === "internet")
    return (
      <svg {...common}>
        <path d="M7 18h10.5a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.5 8.6 4.7 4.7 0 0 0 7 18Z" />
      </svg>
    );
  if (kind === "server")
    return (
      <svg {...common}>
        <rect x="6" y="3" width="12" height="18" rx="1.5" />
        <path d="M9 7h6M9 11h6M9 17h.01" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

const handleStyle = { width: 10, height: 10, background: "#1e293b", border: "2px solid #3b82f6" };

export function DeviceNode({ data, selected }: NodeProps<DevNode>) {
  const d = data.device;
  const l3 = isL3Switch(d);
  const color = l3 ? L3_COLOR : COLORS[d.kind];
  return (
    <div
      className={`flex flex-col items-center px-4 py-3 min-w-[104px] rounded-2xl bg-slate-900 border shadow-xl ${
        selected ? "border-blue-400 ring-2 ring-blue-500/40" : "border-white/10"
      }`}
    >
      <KindIcon kind={d.kind} l3={l3} />
      <p className="mt-1 text-xs font-bold text-white leading-tight">{d.hostname}</p>
      <p className="text-[10px] font-mono leading-tight" style={{ color }}>
        {modelById(d.model).label}
      </p>
      {(d.kind === "pc" || d.kind === "server") && d.ip ? (
        <p className="text-[10px] font-mono text-slate-400 leading-tight">{d.ip}</p>
      ) : null}
      <Handle id="t" type="source" position={Position.Top} style={handleStyle} />
      <Handle id="r" type="source" position={Position.Right} style={handleStyle} />
      <Handle id="b" type="source" position={Position.Bottom} style={handleStyle} />
      <Handle id="l" type="source" position={Position.Left} style={handleStyle} />
    </div>
  );
}

export function LinkEdge({ id, sourceX, sourceY, targetX, targetY, data, selected }: EdgeProps<LinkEdgeT>) {
  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const len = Math.hypot(dx, dy) || 1;
  const off = Math.min(34, len / 2.6);
  const ux = dx / len;
  const uy = dy / len;
  const a = { x: sourceX + ux * off, y: sourceY + uy * off };
  const b = { x: targetX - ux * off, y: targetY - uy * off };
  const wireless = !!data?.wireless;
  const label = (p: { x: number; y: number }, text?: string) =>
    text ? (
    <div
      className="nodrag nopan absolute px-1 rounded bg-[#020617]/90 text-[10px] font-mono text-emerald-300 pointer-events-none"
      style={{ transform: `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)` }}
    >
      {text}
    </div>
    ) : null;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: selected ? "#60a5fa" : wireless ? "#f472b6" : "#64748b",
          strokeWidth: selected ? 3 : 2,
          strokeDasharray: wireless ? "6 5" : undefined,
        }}
        interactionWidth={22}
      />
      <EdgeLabelRenderer>
        {label(a, data?.aLabel)}
        {label(b, data?.bLabel)}
        {wireless && data?.wifi !== undefined && (
          <div
            className="nodrag nopan absolute px-1.5 rounded bg-[#020617]/90 text-[10px] font-mono text-pink-300 pointer-events-none whitespace-nowrap"
            style={{ transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2}px, ${(sourceY + targetY) / 2}px)` }}
          >
            ◠ {data.wifi || "Wi-Fi"}
          </div>
        )}
        {data?.net && (
          <div
            className="nodrag nopan absolute px-2 py-0.5 text-[11px] font-mono font-bold whitespace-nowrap rounded border border-violet-300/60 bg-violet-200 text-slate-900 pointer-events-none shadow"
            style={{
              // Beside the cable: above horizontal ones, to the right of vertical ones.
              transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2 + uy * (Math.abs(uy) * 62 + 4)}px, ${
                (sourceY + targetY) / 2 - ux * (Math.abs(ux) * 18 + 4)
              }px)`,
            }}
          >
            {data.net}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
