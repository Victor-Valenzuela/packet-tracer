import type { Dict } from "../i18n";
import type { RoutingCfg, RoutingProtocol, Topology } from "../lib/types";

interface Props {
  topo: Topology;
  setTopo: (f: (t: Topology) => Topology) => void;
  t: Dict;
}

const inputCls =
  "w-24 bg-black/40 border border-white/10 rounded px-2 py-1 text-xs font-mono text-blue-100 outline-none focus:border-blue-500";

/** How routers learn each other's networks: static routes, RIPv2 or OSPF. Static is the default. */
export default function RoutingPanel({ topo, setTopo, t }: Props) {
  const tr = t.routing;
  const cfg: RoutingCfg = topo.routing ?? { protocol: "static" };
  const hasEdge = topo.devices.some((d) => d.kind === "router" && d.edge?.enabled);
  const write = (patch: Partial<RoutingCfg>) =>
    setTopo((cur) => ({ ...cur, routing: { ...(cur.routing ?? { protocol: "static" }), ...patch } }));
  const num = (v: string, min: number, fallback: number) => Math.max(min, parseInt(v, 10) || fallback);

  return (
    <div className="mb-8 p-6 bg-slate-900 rounded-3xl border border-white/5">
      <h3 className="mb-2 text-lg font-bold text-blue-400 uppercase italic">{tr.title}</h3>
      <p className="mb-5 text-sm text-slate-400 italic">{tr.intro}</p>
      <div className="flex flex-wrap gap-2 p-1 mb-4 bg-white/5 rounded-lg border border-white/10 w-fit" role="radiogroup">
        {(["static", "rip", "ospf"] as RoutingProtocol[]).map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={cfg.protocol === k}
            onClick={() => write({ protocol: k })}
            className={`px-4 py-2 text-[11px] font-bold rounded uppercase tracking-tighter transition-all ${
              cfg.protocol === k ? "bg-blue-500/20 text-blue-400" : "text-slate-500 hover:text-white"
            }`}
          >
            {tr[k].name}
          </button>
        ))}
      </div>
      <p className="text-sm text-slate-300">{tr[cfg.protocol].desc}</p>

      {cfg.protocol !== "static" && (
        <div className="mt-4 space-y-3">
          <label className="flex items-start gap-2 text-xs text-slate-300">
            <input type="checkbox" className="mt-0.5" checked={cfg.passive !== false} onChange={(e) => write({ passive: e.target.checked })} />
            <span>
              {tr.passive}
              <span className="block text-[11px] text-slate-500 italic">{tr.passiveHelp}</span>
            </span>
          </label>
          <label className={`flex items-start gap-2 text-xs text-slate-300 ${hasEdge ? "" : "opacity-50"}`}>
            <input
              type="checkbox"
              className="mt-0.5"
              disabled={!hasEdge}
              checked={cfg.originate !== false}
              onChange={(e) => write({ originate: e.target.checked })}
            />
            <span>
              {tr.originate}
              <span className="block text-[11px] text-slate-500 italic">{tr.originateHelp}</span>
            </span>
          </label>
          {cfg.protocol === "ospf" && (
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-xs text-slate-400">
                {tr.process}
                <input className={inputCls} type="number" min={1} max={65535} value={cfg.ospfProcess ?? 1} onChange={(e) => write({ ospfProcess: num(e.target.value, 1, 1) })} />
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                {tr.area}
                <input className={inputCls} type="number" min={0} value={cfg.ospfArea ?? 0} onChange={(e) => write({ ospfArea: num(e.target.value, 0, 0) })} />
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
