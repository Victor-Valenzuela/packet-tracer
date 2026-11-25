import { fmt, netLabel, type Dict } from "../i18n";
import { findBundles, getDevice, hsrpCandidates } from "../lib/analyze";
import { intToIp, ipToInt } from "../lib/net";
import type { HsrpGroup, Redundancy, Topology } from "../lib/types";

interface Props {
  topo: Topology;
  /** Topology already translated for the chosen scheme: its networks are the ones that exist now. */
  effective: Topology;
  setTopo: (f: (t: Topology) => Topology) => void;
  t: Dict;
  onLoadExample: () => void;
}

const inputCls =
  "bg-black/40 border border-white/10 rounded px-2 py-1 text-sm font-mono text-blue-100 outline-none focus:border-blue-500";
const btnCls =
  "px-3 py-1.5 text-[11px] font-bold tracking-wider uppercase rounded-lg border border-white/10 text-slate-300 hover:text-white hover:bg-white/5 transition";

/** Backup equipment: shared gateways (HSRP), bundled cables (EtherChannel) and the spanning-tree root. */
export default function RedundancyPanel({ topo, effective, setTopo, t, onLoadExample }: Props) {
  const tr = t.redundancy;
  const red: Redundancy = topo.redundancy ?? { hsrp: [] };
  const write = (f: (r: Redundancy) => Redundancy) =>
    setTopo((cur) => ({ ...cur, redundancy: f(cur.redundancy ?? { hsrp: [] }) }));
  const cands = hsrpCandidates(effective);
  const bundles = findBundles(effective);
  const keyOf = (g: HsrpGroup) => g.net;
  const groupOf = (key: string) => red.hsrp.find((g) => keyOf(g) === key);
  const orphans = red.hsrp.filter((g) => !cands.some((c) => c.key === g.net));

  /** First address of the network that no interface uses: a reasonable virtual gateway. */
  const suggestVip = (c: (typeof cands)[number]) => {
    const taken = new Set(
      c.devices.flatMap((d) => [...(d.svis ?? []).map((s) => s.ip), ...Object.values(d.ports).flatMap((p) => [p.ip, ...(p.subifs ?? []).map((s) => s.ip)])]).map((ip) => (ip ? ipToInt(ip.split("/")[0]) : null)),
    );
    for (let ip = c.cidr.net + 1; ip < c.cidr.net + 255 && ip < c.cidr.net + 2 ** (32 - c.cidr.prefix) - 1; ip++) {
      if (!taken.has(ip)) return intToIp(ip);
    }
    return "";
  };
  const patchGroup = (net: string, patch: Partial<HsrpGroup>) =>
    write((r) => ({ ...r, hsrp: r.hsrp.map((g) => (g.net === net ? { ...g, ...patch } : g)) }));

  const channelNames = bundles
    .map((b) => `${getDevice(effective, b.a)?.hostname} ↔ ${getDevice(effective, b.b)?.hostname} (${b.links.length})`)
    .join(", ");

  return (
    <div className="mb-8 p-6 bg-slate-900 rounded-3xl border border-white/5">
      <h3 className="mb-2 text-lg font-bold text-blue-400 uppercase italic">{tr.title}</h3>
      <p className="mb-5 text-sm text-slate-300 italic">{tr.intro}</p>

      <div className="space-y-6">
        <section>
          <h4 className="mb-1 text-sm font-bold tracking-widest text-slate-200 uppercase">{tr.hsrpTitle}</h4>
          <p className="mb-3 text-sm text-slate-400">{tr.hsrpHelp}</p>
          {!cands.length && !orphans.length && <p className="text-sm text-amber-300 italic">{tr.hsrpNone}</p>}
          <div className="space-y-3">
            {cands.map((c) => {
              const g = groupOf(c.key);
              return (
                <div key={c.key} className="p-4 rounded-xl bg-black/30 border border-white/5">
                  <label className="flex items-center gap-2 text-sm font-mono text-slate-200">
                    <input
                      type="checkbox"
                      checked={!!g}
                      onChange={(e) =>
                        write((r) => ({
                          ...r,
                          hsrp: e.target.checked
                            ? [...r.hsrp, { net: c.key, vip: suggestVip(c), active: c.devices[0]?.id }]
                            : r.hsrp.filter((x) => x.net !== c.key),
                        }))
                      }
                    />
                    {netLabel(t, c.key, c)}
                    <span className="text-xs text-slate-500">· {c.devices.map((d) => d.hostname).join(", ")}</span>
                  </label>
                  {g && (
                    <div className="flex flex-wrap items-end gap-4 mt-3 ml-6">
                      <label className="text-xs text-slate-400">
                        <span className="block mb-1 uppercase tracking-widest">{tr.vip}</span>
                        <input className={`${inputCls} w-44`} value={g.vip} onChange={(e) => patchGroup(c.key, { vip: e.target.value })} />
                      </label>
                      <label className="text-xs text-slate-400">
                        <span className="block mb-1 uppercase tracking-widest">{tr.active}</span>
                        <select className={inputCls} value={g.active ?? c.devices[0]?.id} onChange={(e) => patchGroup(c.key, { active: e.target.value })}>
                          {c.devices.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.hostname}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
            {orphans.map((g) => (
              <div key={g.net} className="flex items-center justify-between p-3 rounded-xl bg-black/30 border border-amber-500/20">
                <span className="text-sm font-mono text-amber-300">{g.net}</span>
                <button className={btnCls} onClick={() => write((r) => ({ ...r, hsrp: r.hsrp.filter((x) => x.net !== g.net) }))}>
                  ×
                </button>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h4 className="mb-2 text-sm font-bold tracking-widest text-slate-200 uppercase">{tr.ecTitle}</h4>
          <label className="flex items-center gap-2 text-sm text-slate-200">
            <input type="checkbox" checked={!!red.etherchannel} onChange={(e) => write((r) => ({ ...r, etherchannel: e.target.checked }))} />
            {tr.ecEnable}
          </label>
          <p className="mt-2 ml-6 text-xs text-slate-400 italic">{bundles.length ? fmt(tr.ecFound, { list: channelNames }) : tr.ecNone}</p>
          {red.etherchannel && (
            <label className="flex items-center gap-2 mt-3 ml-6 text-xs text-slate-400">
              {tr.ecMode}
              <select className={inputCls} value={red.channelMode ?? "lacp"} onChange={(e) => write((r) => ({ ...r, channelMode: e.target.value as Redundancy["channelMode"] }))}>
                <option value="lacp">{tr.ecLacp}</option>
                <option value="pagp">{tr.ecPagp}</option>
                <option value="on">{tr.ecOn}</option>
              </select>
            </label>
          )}
        </section>

        <section>
          <h4 className="mb-2 text-sm font-bold tracking-widest text-slate-200 uppercase">{tr.stpTitle}</h4>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input type="checkbox" checked={red.stpAlign !== false} onChange={(e) => write((r) => ({ ...r, stpAlign: e.target.checked }))} />
              {tr.stpAlign}
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input type="checkbox" checked={!!red.rapidPvst} onChange={(e) => write((r) => ({ ...r, rapidPvst: e.target.checked }))} />
              {tr.rapid}
            </label>
          </div>
        </section>

        <button className={btnCls} onClick={onLoadExample}>
          {tr.example}
        </button>
      </div>
    </div>
  );
}
