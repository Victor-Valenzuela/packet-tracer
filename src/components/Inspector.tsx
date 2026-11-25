import type { ReactNode } from "react";
import { fmt, netLabel, type Dict } from "../i18n";
import { analyze, connectedPorts, dhcpCandidates, edgeNetworks, getDevice, networkTags, peerOf } from "../lib/analyze";
import { isL3Switch, MODELS, modelById } from "../lib/catalog";
import { applyScheme, schemeOf } from "../lib/scheme";
import { changeLinkPort, changeModel, disableEdge, enableEdge, freePort, removeDevice, removeLink, updateDevice, updatePort } from "../lib/topology";
import { intToIp, usableHosts } from "../lib/net";
import type { Device, DhcpPool, DhcpServer, EdgeCfg, Topology, WifiCfg, WirelessRouterCfg } from "../lib/types";

export type Selection = { type: "device" | "link"; id: string } | null;

interface Props {
  topo: Topology;
  setTopo: (f: (t: Topology) => Topology) => void;
  sel: Selection;
  t: Dict;
  onDeselect: () => void;
}

const inputCls =
  "w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-xs font-mono text-blue-100 outline-none focus:border-blue-500";
const btnCls =
  "px-2 py-1 text-[11px] font-bold rounded border border-white/10 text-slate-300 hover:text-white hover:bg-white/5 transition";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block mb-1 text-[10px] font-bold tracking-widest text-slate-400 uppercase">{label}</span>
      {children}
    </label>
  );
}

function DhcpSection({
  d,
  topo,
  setTopo,
  t,
  inactive,
}: {
  d: Device;
  topo: Topology;
  setTopo: Props["setTopo"];
  t: Dict;
  inactive: boolean;
}) {
  const ti = t.inspector;
  const srv: DhcpServer = d.dhcpServer ?? { enabled: false, pools: [] };
  const eff = applyScheme(topo);
  const cands = dhcpCandidates(eff);
  const plans = srv.enabled ? analyze(eff).dhcp.pools.filter((p) => p.serverId === d.id) : [];
  const write = (f: (s: DhcpServer) => DhcpServer) =>
    setTopo((cur) =>
      updateDevice(cur, d.id, {
        dhcpServer: f(cur.devices.find((x) => x.id === d.id)?.dhcpServer ?? { enabled: false, pools: [] }),
      }),
    );
  const patchPool = (i: number, patch: Partial<DhcpPool>) =>
    write((s) => ({ ...s, pools: s.pools.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  const newPool = (c: { key: string; cidr: { prefix: number; net: number } }): DhcpPool => ({
    net: c.key,
    // Leave room for the gateway and fixed devices without eating small networks.
    excludeFirst: Math.min(10, Math.max(1, Math.floor(usableHosts({ ...c.cidr, ip: c.cidr.net }) / 4))),
  });
  const used = new Set(srv.pools.map((p) => p.net));
  const free = cands.filter((c) => !used.has(c.key));
  const count = (v: string) => Math.max(0, parseInt(v, 10) || 0);

  return (
    <div className={`space-y-3 p-3 rounded-xl border border-amber-500/20 bg-amber-500/5 ${inactive ? "opacity-50" : ""}`}>
      <label className="flex items-center gap-2 text-xs font-bold text-amber-200">
        <input type="checkbox" checked={srv.enabled} onChange={(e) => write((s) => ({ ...s, enabled: e.target.checked }))} />
        {ti.dhcpEnable}
      </label>
      {inactive && <p className="text-[11px] text-slate-400 italic">{ti.dhcpL2Note}</p>}
      {srv.enabled && (
        <>
          <p className="text-[11px] text-slate-400 italic">{ti.dhcpHelp}</p>
          {srv.pools.map((p, i) => {
            const info = cands.find((c) => c.key === p.net);
            const plan = plans.find((x) => x.key === p.net);
            return (
              <div key={p.net} className="p-3 space-y-2 rounded-lg bg-black/30 border border-white/5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-mono text-amber-200">
                    {netLabel(t, p.net, info)}
                    {info && <span className="ml-2 text-slate-500">{fmt(ti.dhcpClients, { n: info.clients })}</span>}
                  </p>
                  <button className={btnCls} onClick={() => write((s) => ({ ...s, pools: s.pools.filter((_, j) => j !== i) }))}>
                    ×
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={ti.dhcpExcludeFirst}>
                    <input className={inputCls} type="number" min={0} value={p.excludeFirst ?? 10} onChange={(e) => patchPool(i, { excludeFirst: count(e.target.value) })} />
                  </Field>
                  <Field label={ti.dhcpExcludeLast}>
                    <input className={inputCls} type="number" min={0} value={p.excludeLast ?? 0} onChange={(e) => patchPool(i, { excludeLast: count(e.target.value) })} />
                  </Field>
                  <Field label={ti.dhcpGateway}>
                    <input className={inputCls} placeholder={ti.dhcpGatewayAuto} value={p.gateway ?? ""} onChange={(e) => patchPool(i, { gateway: e.target.value })} />
                  </Field>
                  <Field label={ti.dhcpDns}>
                    <input className={inputCls} placeholder="8.8.8.8" value={p.dns ?? ""} onChange={(e) => patchPool(i, { dns: e.target.value })} />
                  </Field>
                  <Field label={ti.dhcpLease}>
                    <input className={inputCls} type="number" min={0} value={p.lease ?? ""} onChange={(e) => patchPool(i, { lease: count(e.target.value) || undefined })} />
                  </Field>
                </div>
                {plan && (
                  <p className="text-[11px] text-slate-500 italic">
                    {fmt(ti.dhcpRange, { n: plan.count, from: intToIp(plan.dynStart), to: intToIp(plan.dynEnd) })}
                  </p>
                )}
              </div>
            );
          })}
          {!cands.length && <p className="text-[11px] text-slate-500 italic">{ti.dhcpNoNets}</p>}
          {free.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <select
                className={`${inputCls} !w-auto`}
                value=""
                onChange={(e) => {
                  const c = free.find((x) => x.key === e.target.value);
                  if (c) write((s) => ({ ...s, pools: [...s.pools, newPool(c)] }));
                }}
              >
                <option value="">+ {ti.dhcpAdd}</option>
                {free.map((c) => (
                  <option key={c.key} value={c.key}>
                    {netLabel(t, c.key, c)} ({fmt(ti.dhcpClients, { n: c.clients })})
                  </option>
                ))}
              </select>
              {free.some((c) => c.clients > 0) && (
                <button
                  className={btnCls}
                  onClick={() => write((s) => ({ ...s, pools: [...s.pools, ...free.filter((c) => c.clients > 0).map(newPool)] }))}
                >
                  {ti.dhcpAddClients}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Wi-Fi network of an access point or wireless router. */
function WifiSection({ d, setTopo, t }: { d: Device; setTopo: Props["setTopo"]; t: Dict }) {
  const ti = t.inspector;
  const w: WifiCfg = d.wifi ?? { ssid: "", security: "wpa2" };
  const write = (patch: Partial<WifiCfg>) =>
    setTopo((cur) =>
      updateDevice(cur, d.id, {
        wifi: { ...(cur.devices.find((x) => x.id === d.id)?.wifi ?? { ssid: "", security: "wpa2" }), ...patch },
      }),
    );
  return (
    <div className="space-y-3 p-3 rounded-xl border border-pink-500/20 bg-pink-500/5">
      <p className="text-[10px] font-bold tracking-widest text-pink-300 uppercase">{ti.wifiTitle}</p>
      <Field label={ti.wifiSsid}>
        <input className={inputCls} value={w.ssid} onChange={(e) => write({ ssid: e.target.value.replace(/[\r\n]+/g, " ") })} />
      </Field>
      <Field label={ti.wifiSecurity}>
        <select className={inputCls} value={w.security} onChange={(e) => write({ security: e.target.value as WifiCfg["security"] })}>
          <option value="wpa2">{ti.wifiWpa2}</option>
          <option value="open">{ti.wifiOpen}</option>
        </select>
      </Field>
      {w.security === "wpa2" && (
        <Field label={ti.wifiPass}>
          <input className={inputCls} value={w.passphrase ?? ""} onChange={(e) => write({ passphrase: e.target.value.replace(/[\r\n]+/g, " ") })} />
        </Field>
      )}
      <Field label={ti.wifiChannel}>
        <select
          className={inputCls}
          value={w.channel ?? ""}
          onChange={(e) => write({ channel: e.target.value ? Number(e.target.value) : undefined })}
        >
          <option value="">{ti.wifiChannelAuto}</option>
          {[1, 6, 11].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

/** Local network and DHCP server of a wireless router. */
function WrLanSection({ d, setTopo, t }: { d: Device; setTopo: Props["setTopo"]; t: Dict }) {
  const ti = t.inspector;
  const wr: WirelessRouterCfg = d.wr ?? { lanIp: "", dhcp: true };
  const write = (patch: Partial<WirelessRouterCfg>) =>
    setTopo((cur) =>
      updateDevice(cur, d.id, {
        wr: { ...(cur.devices.find((x) => x.id === d.id)?.wr ?? { lanIp: "", dhcp: true }), ...patch },
      }),
    );
  const num = (v: string) => Math.max(1, parseInt(v, 10) || 1);
  return (
    <div className="space-y-3 p-3 rounded-xl border border-slate-500/20 bg-white/5">
      <p className="text-[10px] font-bold tracking-widest text-slate-400 uppercase">{ti.wrLanTitle}</p>
      <Field label={ti.wrLanIp}>
        <input className={inputCls} placeholder="192.168.0.1/24" value={wr.lanIp} onChange={(e) => write({ lanIp: e.target.value })} />
      </Field>
      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" checked={wr.dhcp} onChange={(e) => write({ dhcp: e.target.checked })} />
        {ti.wrDhcp}
      </label>
      {wr.dhcp && (
        <div className="grid grid-cols-2 gap-2">
          <Field label={ti.wrDhcpStart}>
            <input className={inputCls} type="number" min={1} value={wr.dhcpStart ?? 100} onChange={(e) => write({ dhcpStart: num(e.target.value) })} />
          </Field>
          <Field label={ti.wrMaxUsers}>
            <input className={inputCls} type="number" min={1} value={wr.maxUsers ?? 50} onChange={(e) => write({ maxUsers: num(e.target.value) })} />
          </Field>
        </div>
      )}
    </div>
  );
}

function EdgeSection({ d, topo, setTopo, t }: { d: Device; topo: Topology; setTopo: Props["setTopo"]; t: Dict }) {
  const ti = t.inspector;
  const edge = d.edge;
  const on = !!edge?.enabled;
  const wan = edge?.wanPort;
  const peer = wan ? peerOf(topo, d.id, wan) : null;
  const isp = peer ? getDevice(topo, peer.deviceId) : undefined;
  const wanPorts = connectedPorts(topo, d.id).filter((p) => {
    const q = peerOf(topo, d.id, p);
    return q && getDevice(topo, q.deviceId)?.kind === "internet";
  });
  const nets = on ? edgeNetworks(applyScheme(topo), d.id) : [];
  const tags = networkTags(applyScheme(topo));
  // Marking the router adds an Internet node and cables it, which needs a free port.
  const blocked = !on && !wanPorts.length && !freePort(topo, d);
  const nat = edge?.nat !== false;
  const excluded = new Set(edge?.natExclude ?? []);
  const setEdge = (patch: Partial<EdgeCfg>) =>
    setTopo((cur) =>
      updateDevice(cur, d.id, { edge: { ...(cur.devices.find((x) => x.id === d.id)?.edge ?? { enabled: false }), ...patch } }),
    );

  return (
    <div className="space-y-3 p-3 rounded-xl border border-sky-500/20 bg-sky-500/5">
      <label className="flex items-center gap-2 text-xs font-bold text-sky-200">
        <input
          type="checkbox"
          checked={on}
          disabled={blocked}
          onChange={(e) => setTopo((cur) => (e.target.checked ? enableEdge(cur, d.id) : disableEdge(cur, d.id)))}
        />
        {ti.edgeEnable}
      </label>
      {blocked ? (
        <p className="text-[11px] text-amber-300 italic">{fmt(ti.edgeNoFreePort, { dev: d.hostname })}</p>
      ) : (
        !on && <p className="text-[11px] text-slate-400 italic">{ti.edgeHelp}</p>
      )}
      {on && (
        <>
          {!wanPorts.length || !peer || !isp ? (
            <p className="text-[11px] text-amber-300 italic">{ti.edgeNoLink}</p>
          ) : (
            <>
              <Field label={ti.edgeWan}>
                <select className={inputCls} value={wan ?? ""} onChange={(e) => setEdge({ wanPort: e.target.value })}>
                  {wanPorts.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={ti.edgeWanIp}>
                <input
                  className={inputCls}
                  placeholder="203.0.113.2/30"
                  value={d.ports[wan!]?.ip ?? ""}
                  onChange={(e) => setTopo((cur) => updatePort(cur, d.id, wan!, { ip: e.target.value }))}
                />
              </Field>
              <Field label={ti.edgeIspIp}>
                <input
                  className={inputCls}
                  placeholder="203.0.113.1/30"
                  value={isp.ports[peer.port]?.ip ?? ""}
                  onChange={(e) => setTopo((cur) => updatePort(cur, isp.id, peer.port, { ip: e.target.value }))}
                />
              </Field>
            </>
          )}
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={nat} onChange={(e) => setEdge({ nat: e.target.checked })} />
            {ti.edgeNat}
          </label>
          {nat ? (
            <div className="space-y-1">
              <p className="text-[10px] font-bold tracking-widest text-slate-400 uppercase">{ti.edgeNatNets}</p>
              {nets.map((n) => {
                const key = `${intToIp(n.net)}/${n.prefix}`;
                return (
                  <label key={key} className="flex items-center gap-2 text-xs font-mono text-slate-300">
                    <input
                      type="checkbox"
                      checked={!excluded.has(key)}
                      onChange={(e) =>
                        setEdge({ natExclude: e.target.checked ? [...excluded].filter((k) => k !== key) : [...excluded, key] })
                      }
                    />
                    {netLabel(t, key, tags.get(key))}
                  </label>
                );
              })}
            </div>
          ) : (
            <p className="text-[11px] text-slate-400 italic">{ti.edgeNatOff}</p>
          )}
        </>
      )}
    </div>
  );
}

const vlanNum = (v: string) => Math.min(4094, Math.max(1, parseInt(v, 10) || 1));

export default function Inspector({ topo, setTopo, sel, t, onDeselect }: Props) {
  const ti = t.inspector;
  if (!sel) return <p className="text-sm text-slate-500 italic">{ti.none}</p>;

  if (sel.type === "link") {
    const l = topo.links.find((x) => x.id === sel.id);
    const A = l && getDevice(topo, l.a);
    const B = l && getDevice(topo, l.b);
    if (!l || !A || !B) return <p className="text-sm text-slate-500 italic">{ti.none}</p>;
    if (l.wireless) {
      const ssid = [A, B].find((x) => x.wifi)?.wifi?.ssid?.trim();
      return (
        <div className="space-y-4">
          <h4 className="text-sm font-bold text-blue-400 uppercase">{ti.link}</h4>
          <p className="text-sm font-mono text-pink-300">{ssid ? fmt(ti.wifiLink, { ssid }) : ti.wifiLinkNoSsid}</p>
          <p className="text-[11px] text-slate-400 italic">{ti.wifiLinkHelp}</p>
          <button
            className={`${btnCls} text-red-300`}
            onClick={() => {
              setTopo((cur) => removeLink(cur, l.id));
              onDeselect();
            }}
          >
            {t.actions.delete}
          </button>
        </div>
      );
    }
    const sideEditor = (dev: Device, end: "a" | "b", port: string) => {
      const used = connectedPorts(topo, dev.id);
      return (
        <Field label={fmt(ti.portA, { dev: dev.hostname })}>
          <select
            className={inputCls}
            value={port}
            onChange={(e) => setTopo((cur) => changeLinkPort(cur, l.id, end, e.target.value))}
          >
            {modelById(dev.model).ports.map((p) => (
              <option key={p} value={p} disabled={p !== port && used.includes(p)}>
                {p} {p !== port && used.includes(p) ? ti.portBusy : ""}
              </option>
            ))}
          </select>
        </Field>
      );
    };
    return (
      <div className="space-y-4">
        <h4 className="text-sm font-bold text-blue-400 uppercase">{ti.link}</h4>
        {sideEditor(A, "a", l.aPort)}
        {sideEditor(B, "b", l.bPort)}
        <button
          className={`${btnCls} text-red-300`}
          onClick={() => {
            setTopo((cur) => removeLink(cur, l.id));
            onDeselect();
          }}
        >
          {t.actions.delete}
        </button>
      </div>
    );
  }

  const d = getDevice(topo, sel.id);
  if (!d) return <p className="text-sm text-slate-500 italic">{ti.none}</p>;
  const set = (patch: Partial<Device>) => setTopo((cur) => updateDevice(cur, d.id, patch));
  const model = modelById(d.model);
  const l3 = isL3Switch(d);
  const scheme = schemeOf(topo);
  // Routers wired to this device through a port that has subinterfaces (used to copy VLAN gateways).
  const subRouters: { dev: Device; subifs: NonNullable<Device["ports"][string]["subifs"]> }[] = [];
  for (const port of connectedPorts(topo, d.id)) {
    const p = peerOf(topo, d.id, port);
    const pd = p && getDevice(topo, p.deviceId);
    const subs = pd && pd.kind === "router" ? pd.ports[p!.port]?.subifs : undefined;
    if (pd && subs?.length && !subRouters.some((r) => r.dev.id === pd.id)) subRouters.push({ dev: pd, subifs: subs });
  }
  const connected = model.ports.filter((p) => connectedPorts(topo, d.id).includes(p));
  const peerLabel = (port: string) => {
    const p = peerOf(topo, d.id, port);
    const pd = p && getDevice(topo, p.deviceId);
    return pd ? fmt(ti.peer, { dev: pd.hostname, port: p!.port }) : "";
  };

  return (
    <div className="space-y-4">
      <h4 className="text-sm font-bold text-blue-400 uppercase">
        {t.kinds[d.kind]} · {d.hostname}
      </h4>
      <Field label={ti.hostname}>
        <input className={inputCls} value={d.hostname} onChange={(e) => set({ hostname: e.target.value.replace(/\s+/g, "-") })} />
      </Field>
      <Field label={ti.model}>
        <select className={inputCls} value={d.model} onChange={(e) => setTopo((cur) => changeModel(cur, d.id, e.target.value))}>
          {MODELS.filter((m) => m.kind === d.kind).map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>

      {d.kind === "ap" && <p className="text-[11px] text-slate-400 italic">{ti.apHelp}</p>}
      {(d.kind === "pc" || d.kind === "server" || d.kind === "wrouter") && (
        <>
          {d.kind === "wrouter" && (
            <>
              <p className="text-[11px] text-slate-400 italic">{ti.wrHelp}</p>
              <p className="text-[10px] font-bold tracking-widest text-slate-400 uppercase">{ti.wrWanTitle}</p>
            </>
          )}
          <Field label={ti.ipMode}>
            <select className={inputCls} value={d.useDhcp ? "dhcp" : "static"} onChange={(e) => set({ useDhcp: e.target.value === "dhcp" })}>
              <option value="static">{ti.ipStatic}</option>
              <option value="dhcp">{ti.ipDhcp}</option>
            </select>
          </Field>
          {!d.useDhcp && (
            <>
              <Field label={ti.ip}>
                <input className={inputCls} placeholder={ti.ipPlaceholder} value={d.ip ?? ""} onChange={(e) => set({ ip: e.target.value })} />
              </Field>
              <Field label={ti.gateway}>
                <input className={inputCls} placeholder="192.168.10.1" value={d.gateway ?? ""} onChange={(e) => set({ gateway: e.target.value })} />
              </Field>
            </>
          )}
        </>
      )}

      {d.kind === "wrouter" && <WrLanSection d={d} setTopo={setTopo} t={t} />}
      {(d.kind === "ap" || d.kind === "wrouter") && <WifiSection d={d} setTopo={setTopo} t={t} />}

      {d.kind === "switch" && (
        <>
          <div className="space-y-2">
            <p className="text-[10px] font-bold tracking-widest text-slate-400 uppercase">{ti.vlans}</p>
            {(d.vlans ?? []).map((v, i) => (
              <div key={i} className="flex gap-2">
                <input
                  className={`${inputCls} !w-16`}
                  type="number"
                  min={2}
                  max={4094}
                  value={v.id}
                  onChange={(e) => set({ vlans: d.vlans!.map((x, j) => (j === i ? { ...x, id: vlanNum(e.target.value) } : x)) })}
                />
                <input
                  className={inputCls}
                  placeholder={ti.vlanName}
                  value={v.name}
                  onChange={(e) => set({ vlans: d.vlans!.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                />
                <button className={btnCls} onClick={() => set({ vlans: d.vlans!.filter((_, j) => j !== i) })}>
                  ×
                </button>
              </div>
            ))}
            <button
              className={btnCls}
              onClick={() => {
                const next = Math.max(0, ...(d.vlans ?? []).map((v) => v.id)) + 10;
                set({ vlans: [...(d.vlans ?? []), { id: next, name: "" }] });
              }}
            >
              + {ti.addVlan}
            </button>
          </div>

          {l3 && (
            <div className={`space-y-2 p-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 ${scheme === "roas" ? "opacity-50" : ""}`}>
              <p className="text-[10px] font-bold tracking-widest text-cyan-300 uppercase">{ti.svis}</p>
              <p className="text-[11px] text-slate-400 italic">{scheme === "roas" ? ti.onlyCore : ti.svisHelp}</p>
              {(d.svis ?? []).map((sv, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    className={`${inputCls} !w-16`}
                    type="number"
                    min={1}
                    max={4094}
                    title={ti.vlan}
                    value={sv.vlan}
                    onChange={(e) => set({ svis: d.svis!.map((x, j) => (j === i ? { ...x, vlan: vlanNum(e.target.value) } : x)) })}
                  />
                  <input
                    className={inputCls}
                    placeholder="192.168.10.1/24"
                    value={sv.ip}
                    onChange={(e) => set({ svis: d.svis!.map((x, j) => (j === i ? { ...x, ip: e.target.value } : x)) })}
                  />
                  <button className={btnCls} onClick={() => set({ svis: d.svis!.filter((_, j) => j !== i) })}>
                    ×
                  </button>
                </div>
              ))}
              <button
                className={btnCls}
                onClick={() => {
                  const known = [...(d.vlans ?? []).map((v) => v.id)].filter((id) => !(d.svis ?? []).some((s) => s.vlan === id));
                  const next = known[0] ?? Math.max(0, ...(d.svis ?? []).map((s) => s.vlan)) + 10;
                  set({ svis: [...(d.svis ?? []), { vlan: next, ip: "" }] });
                }}
              >
                + {ti.addSvi}
              </button>
              {subRouters.map((r) => (
                <button
                  key={r.dev.id}
                  className={`${btnCls} block`}
                  onClick={() => set({ svis: r.subifs.map((x) => ({ vlan: x.vlan, ip: x.ip })) })}
                >
                  {fmt(ti.copySubs, { dev: r.dev.hostname })}
                </button>
              ))}
            </div>
          )}

          {l3 && scheme !== "roas" && <p className="text-[11px] text-slate-500 italic">{ti.mgmtRoasOnly}</p>}
          {(!l3 || scheme === "roas") && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={!!d.mgmt}
                onChange={(e) => set({ mgmt: e.target.checked ? { vlan: d.vlans?.[0]?.id ?? 1, ip: "", gateway: "" } : undefined })}
              />
              {ti.mgmtEnable}
            </label>
            {d.mgmt && (
              <div className="grid grid-cols-2 gap-2">
                <Field label={ti.vlan}>
                  <input
                    className={inputCls}
                    type="number"
                    min={1}
                    value={d.mgmt.vlan}
                    onChange={(e) => set({ mgmt: { ...d.mgmt!, vlan: vlanNum(e.target.value) } })}
                  />
                </Field>
                <Field label={ti.ip}>
                  <input className={inputCls} placeholder="10.0.99.2/24" value={d.mgmt.ip} onChange={(e) => set({ mgmt: { ...d.mgmt!, ip: e.target.value } })} />
                </Field>
                <div className="col-span-2">
                  <Field label={ti.gateway}>
                    <input className={inputCls} value={d.mgmt.gateway ?? ""} onChange={(e) => set({ mgmt: { ...d.mgmt!, gateway: e.target.value } })} />
                  </Field>
                </div>
              </div>
            )}
          </div>
          )}
        </>
      )}

      {d.kind === "internet" && (
        <div className="space-y-3">
          <p className="text-[11px] text-slate-400 italic">{ti.ispHelp}</p>
          {connected.map((port) => (
            <div key={port} className="p-3 space-y-2 rounded-xl bg-black/30 border border-white/5">
              <p className="text-xs font-mono text-emerald-300">
                {port} <span className="text-slate-500">{peerLabel(port)}</span>
              </p>
              <Field label={ti.ispPortIp}>
                <input
                  className={inputCls}
                  placeholder="203.0.113.1/30"
                  value={d.ports[port]?.ip ?? ""}
                  onChange={(e) => setTopo((cur) => updatePort(cur, d.id, port, { ip: e.target.value }))}
                />
              </Field>
            </div>
          ))}
          <Field label={ti.ispTest}>
            <input className={inputCls} placeholder="8.8.8.8" value={d.testIp ?? ""} onChange={(e) => set({ testIp: e.target.value })} />
          </Field>
          <p className="text-[11px] text-slate-500 italic">{ti.ispTestHelp}</p>
        </div>
      )}

      {d.kind === "router" && (
        <div className="space-y-2">
          <p className="text-[10px] font-bold tracking-widest text-slate-400 uppercase">Internet</p>
          <EdgeSection d={d} topo={topo} setTopo={setTopo} t={t} />
        </div>
      )}

      {(d.kind === "router" || d.kind === "server" || l3) && (
        <div className="space-y-2">
          <p className="text-[10px] font-bold tracking-widest text-slate-400 uppercase">{ti.dhcpTitle}</p>
          <DhcpSection d={d} topo={topo} setTopo={setTopo} t={t} inactive={l3 && scheme === "roas"} />
        </div>
      )}

      {(d.kind === "router" || d.kind === "switch") && (
        <div className="space-y-3">
          <p className="text-[10px] font-bold tracking-widest text-slate-400 uppercase">{ti.ports}</p>
          {!connected.length && <p className="text-xs text-slate-500 italic">{ti.noPorts}</p>}
          {connected.map((port) => {
            const cfg = d.ports[port] ?? {};
            const upd = (patch: Parameters<typeof updatePort>[3]) => setTopo((cur) => updatePort(cur, d.id, port, patch));
            return (
              <div key={port} className="p-3 space-y-2 rounded-xl bg-black/30 border border-white/5">
                <p className="text-xs font-mono text-emerald-300">
                  {port} <span className="text-slate-500">{peerLabel(port)}</span>
                </p>

                {d.kind === "router" && (() => {
                  const peer = peerOf(topo, d.id, port);
                  const pd = peer && getDevice(topo, peer.deviceId);
                  const svSource = pd && isL3Switch(pd) && pd.svis?.length ? pd : null;
                  const subs = cfg.subifs ?? [];
                  return (
                    <>
                      <div className={scheme === "roas" && subs.length ? "opacity-50" : ""}>
                        <Field label={ti.routerIp}>
                          <input className={inputCls} placeholder="10.0.12.1/30" value={cfg.ip ?? ""} onChange={(e) => upd({ ip: e.target.value })} />
                        </Field>
                      </div>
                      <div className={`space-y-2 ${scheme === "core" ? "opacity-50" : ""}`}>
                        <p className="text-[10px] font-bold tracking-widest text-slate-400 uppercase">{ti.subifs}</p>
                        <p className="text-[11px] text-slate-400 italic">{scheme === "core" ? ti.onlyRoas : ti.subHelp}</p>
                        {subs.map((sb, i) => (
                          <div key={i} className="flex gap-2">
                            <input
                              className={`${inputCls} !w-16`}
                              type="number"
                              min={1}
                              max={4094}
                              title={ti.vlan}
                              value={sb.vlan}
                              onChange={(e) => upd({ subifs: subs.map((x, j) => (j === i ? { ...x, vlan: vlanNum(e.target.value) } : x)) })}
                            />
                            <input
                              className={inputCls}
                              placeholder="192.168.20.1/24"
                              value={sb.ip}
                              onChange={(e) => upd({ subifs: subs.map((x, j) => (j === i ? { ...x, ip: e.target.value } : x)) })}
                            />
                            <button
                              className={btnCls}
                              onClick={() => {
                                const rest = subs.filter((_, j) => j !== i);
                                upd({ subifs: rest.length ? rest : undefined });
                              }}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        <div className="flex flex-wrap gap-2">
                          <button
                            className={btnCls}
                            onClick={() => {
                              const next = Math.max(0, ...subs.map((x) => x.vlan)) + 10;
                              upd({ subifs: [...subs, { vlan: next, ip: "" }] });
                            }}
                          >
                            + {ti.addSub}
                          </button>
                          {svSource && (
                            <button
                              className={btnCls}
                              onClick={() => upd({ subifs: svSource.svis!.map((x) => ({ vlan: x.vlan, ip: x.ip })) })}
                            >
                              {fmt(ti.copySvis, { dev: svSource.hostname })}
                            </button>
                          )}
                        </div>
                      </div>
                    </>
                  );
                })()}

                {d.kind === "switch" && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <Field label={l3 ? ti.l2Mode : ti.mode}>
                        <select className={inputCls} value={cfg.mode ?? "access"} onChange={(e) => upd({ mode: e.target.value as "access" | "trunk" })}>
                          <option value="access">{ti.access}</option>
                          <option value="trunk">{ti.trunk}</option>
                        </select>
                      </Field>
                      {(cfg.mode ?? "access") === "access" && (
                        <Field label={ti.vlan}>
                          <input
                            className={inputCls}
                            type="number"
                            min={1}
                            max={4094}
                            list={`vlans-${d.id}`}
                            value={cfg.vlan ?? 1}
                            onChange={(e) => upd({ vlan: vlanNum(e.target.value) })}
                          />
                          <datalist id={`vlans-${d.id}`}>
                            {(d.vlans ?? []).map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.name}
                              </option>
                            ))}
                          </datalist>
                        </Field>
                      )}
                    </div>
                    {l3 && (
                      <div className={`space-y-2 ${scheme === "roas" ? "opacity-50" : ""}`}>
                        <label className="flex items-center gap-2 text-xs text-slate-300">
                          <input type="checkbox" checked={!!cfg.routed} onChange={(e) => upd({ routed: e.target.checked })} />
                          {ti.routedCore}
                        </label>
                        {scheme === "roas" && <p className="text-[11px] text-slate-400 italic">{ti.onlyCore}</p>}
                        {cfg.routed && (
                          <Field label={ti.routerIp}>
                            <input className={inputCls} placeholder="10.0.20.2/30" value={cfg.ip ?? ""} onChange={(e) => upd({ ip: e.target.value })} />
                          </Field>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <button
        className={`${btnCls} text-red-300`}
        onClick={() => {
          setTopo((cur) => removeDevice(cur, d.id));
          onDeselect();
        }}
      >
        {t.actions.delete}
      </button>
    </div>
  );
}
