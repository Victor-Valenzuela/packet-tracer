import { fmt, netLabel, type Dict } from "../i18n";
import { lanNetworks, pairOf } from "../lib/analyze";
import type { NetPolicy, Topology } from "../lib/types";

interface Props {
  topo: Topology;
  /** Topology already translated for the chosen scheme: its networks are the ones that exist now. */
  effective: Topology;
  setTopo: (f: (t: Topology) => Topology) => void;
  t: Dict;
}

const btnCls =
  "px-3 py-1.5 text-[11px] font-bold tracking-wider uppercase rounded-lg border border-white/10 text-slate-300 hover:text-white hover:bg-white/5 transition";

/** Which networks may not talk to each other. Becomes ACLs on the gateway of each network. */
export default function PolicyPanel({ topo, effective, setTopo, t }: Props) {
  const tp = t.policy;
  const nets = lanNetworks(effective);
  const enabled = !!topo.policy?.enabled;
  const same = (a: [string, string], b: [string, string]) => a[0] === b[0] && a[1] === b[1];
  const blocked = (topo.policy?.blocked ?? []).map(([a, b]) => pairOf(a, b));
  const isBlocked = (a: string, b: string) => blocked.some((p) => same(p, pairOf(a, b)));
  const write = (f: (p: NetPolicy) => NetPolicy) =>
    setTopo((cur) => ({ ...cur, policy: f(cur.policy ?? { enabled: false, blocked: [] }) }));
  const toggle = (a: string, b: string, on: boolean) =>
    write((p) => {
      const pair = pairOf(a, b);
      const rest = p.blocked.map(([x, y]) => pairOf(x, y)).filter((q) => !same(q, pair));
      return { ...p, blocked: on ? [...rest, pair] : rest };
    });
  const allPairs = () => nets.flatMap((a, i) => nets.slice(i + 1).map((b) => pairOf(a.key, b.key)));
  const label = (n: (typeof nets)[number]) => netLabel(t, n.key, n);

  return (
    <div className="p-8 bg-slate-900 rounded-3xl border border-white/5">
      <h3 className="mb-2 text-lg font-bold text-blue-400 uppercase italic">{tp.title}</h3>
      <p className="mb-4 text-sm text-slate-400 italic">{tp.intro}</p>
      <label className="flex items-center gap-2 text-xs font-bold text-slate-200">
        <input type="checkbox" checked={enabled} onChange={(e) => write((p) => ({ ...p, enabled: e.target.checked }))} />
        {tp.enable}
      </label>

      {enabled &&
        (nets.length < 2 ? (
          <p className="mt-4 text-sm text-amber-300 italic">{tp.none}</p>
        ) : (
          <div className="mt-5 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <button className={btnCls} onClick={() => write((p) => ({ ...p, blocked: allPairs() }))}>
                {tp.blockAll}
              </button>
              <button className={btnCls} onClick={() => write((p) => ({ ...p, blocked: [] }))}>
                {tp.allowAll}
              </button>
              <span className="text-xs text-slate-500 italic">{tp.legend}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="text-xs font-mono border-separate border-spacing-1">
                <thead>
                  <tr>
                    <th />
                    {nets.slice(1).map((n) => (
                      <th key={n.key} className="px-2 py-1 text-left font-normal text-slate-400 whitespace-nowrap">
                        {label(n)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {nets.slice(0, -1).map((row, i) => (
                    <tr key={row.key}>
                      <th className="px-2 py-1 text-left font-normal text-slate-400 whitespace-nowrap">{label(row)}</th>
                      {nets.slice(1).map((col, j) => {
                        // Only the upper triangle: the pair is the same in both directions.
                        const show = j + 1 > i;
                        return (
                          <td key={col.key} className={`px-2 py-1 text-center rounded ${show ? "bg-black/30" : ""}`}>
                            {show && (
                              <input
                                type="checkbox"
                                aria-label={fmt(tp.cell, { a: row.key, b: col.key })}
                                title={fmt(tp.cell, { a: row.key, b: col.key })}
                                checked={isBlocked(row.key, col.key)}
                                onChange={(e) => toggle(row.key, col.key, e.target.checked)}
                              />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
    </div>
  );
}
