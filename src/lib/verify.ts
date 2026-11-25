import { fmt, type Dict } from "../i18n";
import { bundlePorts, connectedPorts, getDevice, l2Segment, pairOf, peerOf, type Analysis } from "./analyze";
import { isL3Device } from "./catalog";
import { intToIp, ipToInt, netKey, parseCidr, type Cidr } from "./net";
import type { Device, Issue, Settings, Topology } from "./types";

export interface PlanItem {
  /** Stable, so a ticked test stays ticked when the plan is rebuilt. */
  id: string;
  where: string;
  command: string;
  expected: string;
  outcome: "ok" | "fail" | "info";
}

export interface PlanGroup {
  id: string;
  title: string;
  hint: string;
  items: PlanItem[];
}

const cidrText = (c: Cidr) => `${intToIp(c.net)}/${c.prefix}`;

/** VLANs of the access ports of a switch (the ones DHCP snooping and ARP inspection watch). */
const accessVlansOf = (t: Topology, sw: Device): number[] =>
  [
    ...new Set(
      connectedPorts(t, sw.id)
        .filter((p) => sw.ports[p]?.mode !== "trunk" && sw.ports[p]?.mode !== "routed")
        .map((p) => sw.ports[p]?.vlan ?? 1),
    ),
  ].sort((a, b) => a - b);

/** Problems that come from the global settings rather than from the drawing. */
export function settingsIssues(t: Topology, s: Settings): Issue[] {
  const issues: Issue[] = [];
  if (s.dai && !s.dhcpSnooping) issues.push({ level: "warn", code: "daiNoSnooping", args: {} });
  if (s.stormControl && s.target === "pt") issues.push({ level: "warn", code: "stormPt", args: {} });
  if (s.nativeVlan) {
    const vlan = Math.floor(s.nativeVlanId) || 999;
    const used = new Set<number>();
    for (const d of t.devices) {
      for (const v of d.vlans ?? []) used.add(v.id);
      for (const c of Object.values(d.ports)) {
        if (c.vlan) used.add(c.vlan);
        for (const sub of c.subifs ?? []) used.add(sub.vlan);
      }
    }
    if (used.has(vlan)) issues.push({ level: "warn", code: "nativeUsed", args: { vlan } });
  }
  // ARP inspection drops the ARP of anything that did not get its address from the DHCP server.
  if (s.dai && s.dhcpSnooping) {
    for (const h of t.devices) {
      if ((h.kind !== "pc" && h.kind !== "server" && h.kind !== "wrouter") || h.useDhcp || !h.ip?.trim()) continue;
      const vlan = l2Segment(t, h).vlan;
      const inspected = t.devices.some((sw) => sw.kind === "switch" && accessVlansOf(t, sw).includes(vlan ?? 1));
      if (vlan !== undefined && inspected) issues.push({ level: "warn", code: "daiStatic", args: { dev: h.hostname, vlan } });
    }
  }
  return issues;
}

/**
 * Tests to run once everything is configured, ordered from cables to services, each with the result
 * to expect. The expectations come from the configuration (routes, ACLs, NAT), not from a simulation.
 * Expects the topology already translated by `applyScheme`.
 */
export function buildPlan(t: Topology, an: Analysis, s: Settings, d: Dict): PlanGroup[] {
  const p = d.plan;
  const groups: PlanGroup[] = [];
  const item = (group: string, where: string, command: string, expected: string, outcome: PlanItem["outcome"]): PlanItem => ({
    id: `${group}|${where}|${command}`,
    where,
    command,
    expected,
    outcome,
  });
  const push = (id: keyof typeof p.groups, items: PlanItem[]) => {
    if (items.length) groups.push({ id, title: p.groups[id].title, hint: p.groups[id].hint, items });
  };

  // Which networks are joined by routers: two networks in the same set can reach each other.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const i of an.ifaces) parent.set(find(`d:${i.deviceId}`), find(`n:${netKey(i.cidr)}`));
  const joined = (a: string, b: string) => a === b || find(`n:${a}`) === find(`n:${b}`);

  const wanKeys = new Set([...an.edges.values()].flatMap((e) => (e.wanIp ? [netKey(e.wanIp)] : [])));
  const blocked = new Set((t.policy?.enabled ? t.policy.blocked : []).map(([a, b]) => pairOf(a, b).join("|")));

  const linked = (x: Device) => connectedPorts(t, x.id).length > 0;
  const hosts = t.devices.filter((x) => (x.kind === "pc" || x.kind === "server") && linked(x));
  const info = (x: Device) => an.dhcp.hosts.get(x.id);
  const hostNet = (x: Device) => (info(x)?.net ? netKey(info(x)!.net!) : null);
  /** Network the rest of the topology sees: behind a wireless router that is the router's own WAN network. */
  const seenNet = (x: Device) => {
    const wr = info(x)?.viaWr;
    const n = wr ? an.dhcp.hosts.get(wr.id)?.net : info(x)?.net;
    return n ? netKey(n) : null;
  };
  const ipOf = (x: Device) => {
    const c = x.useDhcp ? null : parseCidr(x.ip);
    return c ? intToIp(c.ip) : `<${x.hostname}>`;
  };

  // 1. Interfaces and VLANs
  const links: PlanItem[] = [];
  for (const x of t.devices) {
    if (isL3Device(x) || x.kind === "internet") {
      links.push(item("links", x.hostname, "show ip interface brief", p.e.ifaces, "info"));
    }
    if (x.kind === "switch") {
      const vl = [...(x.vlans ?? []).map((v) => v.id), ...(x.svis ?? []).map((v) => v.vlan)].filter((v, i, a) => v !== 1 && a.indexOf(v) === i);
      const ports = connectedPorts(t, x.id);
      if (vl.length || ports.length) links.push(item("links", x.hostname, "show vlan brief", vl.length ? fmt(p.e.vlans, { vlans: vl.sort((a, b) => a - b).join(", ") }) : p.e.ifaces, "info"));
      const trunks = ports.filter((port) => x.ports[port]?.mode === "trunk");
      if (trunks.length) links.push(item("links", x.hostname, "show interfaces trunk", fmt(p.e.trunks, { ports: trunks.join(", ") }), "info"));
    }
  }
  push("links", links);

  // 2. Every host reaches its own gateway
  const gateway: PlanItem[] = [];
  for (const h of hosts) {
    const gw = info(h)?.gateway;
    if (gw == null) continue;
    gateway.push(item("gateway", h.hostname, `ping ${intToIp(gw)}`, fmt(p.e.gw, { gw: intToIp(gw) }), "ok"));
  }
  push("gateway", gateway);

  // 3. Hosts of the same network see each other
  const byNet = new Map<string, Device[]>();
  for (const h of hosts) {
    const k = hostNet(h);
    if (k) byNet.set(k, [...(byNet.get(k) ?? []), h]);
  }
  const same: PlanItem[] = [];
  for (const [k, list] of byNet) {
    for (const other of list.slice(1)) {
      same.push(item("same", list[0].hostname, `ping ${ipOf(other)}`, fmt(p.e.same, { b: other.hostname, net: k }), "ok"));
    }
  }
  push("same", same);

  // 4. One host per network tests every other network
  const reps = [...byNet.values()].map((list) => list.find((h) => !h.useDhcp && parseCidr(h.ip)) ?? list[0]);
  const inter: PlanItem[] = [];
  const test = (a: Device, b: Device) => {
    const from = seenNet(a);
    const to = hostNet(b);
    if (!from || !to) return;
    const cmd = `ping ${ipOf(b)}`;
    // Behind a wireless router nothing can start a conversation from outside; the other direction works (NAT).
    const otherWr = info(b)?.viaWr && info(b)!.viaWr!.id !== info(a)?.viaWr?.id;
    if (otherWr) inter.push(item("inter", a.hostname, cmd, fmt(p.e.interNat, { b: b.hostname }), "fail"));
    else if (blocked.has(pairOf(from, to).join("|"))) inter.push(item("inter", a.hostname, cmd, fmt(p.e.interBlocked, { a: from, b: to }), "fail"));
    else if (!joined(from, to)) inter.push(item("inter", a.hostname, cmd, fmt(p.e.interNoRoute, { a: from, b: to }), "fail"));
    else inter.push(item("inter", a.hostname, cmd, fmt(p.e.interOk, { a: from, b: to }), "ok"));
  };
  reps.forEach((a, i) => {
    for (const b of reps.slice(i + 1)) {
      test(a, b);
      if (info(a)?.viaWr || info(b)?.viaWr) test(b, a);
    }
  });
  push("inter", inter);

  // 5. Routes and routing protocols
  const routing: PlanItem[] = [];
  for (const x of t.devices.filter(isL3Device)) {
    const plan = an.dyn.get(x.id);
    const own = new Set(an.ifaces.filter((i) => i.deviceId === x.id).map((i) => netKey(i.cidr)));
    if (plan) {
      const neighbors = new Set<string>();
      for (const i of an.ifaces) {
        if (i.deviceId !== x.id && own.has(netKey(i.cidr)) && !wanKeys.has(netKey(i.cidr))) neighbors.add(i.deviceId);
      }
      if (!neighbors.size) continue;
      const proto = plan.protocol === "rip" ? "RIPv2" : "OSPF";
      routing.push(item("routing", x.hostname, "show ip protocols", fmt(p.e.protocols, { proto, nets: plan.networks.map(cidrText).join(", ") }), "info"));
      if (plan.protocol === "ospf") routing.push(item("routing", x.hostname, "show ip ospf neighbor", fmt(p.e.ospfNbr, { n: neighbors.size }), "info"));
      const remote = [...new Set(an.ifaces.filter((i) => !own.has(netKey(i.cidr)) && !wanKeys.has(netKey(i.cidr)) && find(`d:${x.id}`) === find(`d:${i.deviceId}`)).map((i) => cidrText(i.cidr)))];
      const learnsDefault = an.edges.size > 0 && !an.edges.has(x.id) && !!t.routing && t.routing.originate !== false;
      if (remote.length) {
        routing.push(
          item("routing", x.hostname, "show ip route", fmt(p.e.routesDyn, { code: plan.protocol === "rip" ? "R" : "O", nets: remote.join(", ") }) + (learnsDefault ? ` ${p.e.defaultLearned}` : ""), "info"),
        );
      }
    } else {
      const routes = an.routes.get(x.id) ?? [];
      const specific = routes.filter((r) => r.net.prefix > 0);
      if (specific.length) {
        routing.push(item("routing", x.hostname, "show ip route", fmt(p.e.routesStatic, { nets: specific.map((r) => cidrText(r.net)).join(", ") }), "info"));
      }
    }
  }
  push("routing", routing);

  // 5b. Redundancy: HSRP, spanning-tree root and EtherChannel
  const redundancy: PlanItem[] = [];
  for (const g of an.hsrpGroups) {
    const active = getDevice(t, g.activeId);
    if (!active) continue;
    const vip = intToIp(g.vip);
    redundancy.push(item("redundancy", active.hostname, "show standby brief", fmt(p.e.hsrpActive, { group: g.group, net: g.net, vip }), "info"));
    const standby = g.standbyIds.map((id) => getDevice(t, id)).filter((x): x is Device => !!x);
    for (const sb of standby) {
      redundancy.push(item("redundancy", sb.hostname, "show standby brief", fmt(p.e.hsrpStandby, { group: g.group, active: active.hostname }), "info"));
    }
    const host = reps.find((h) => hostNet(h) === g.net) ?? hosts.find((h) => hostNet(h) === g.net);
    if (host) redundancy.push(item("redundancy", host.hostname, `ping ${vip}`, fmt(p.e.hsrpPing, { vip }), "ok"));
    if (standby[0]) {
      redundancy.push(item("redundancy", active.hostname, "shutdown", fmt(p.e.hsrpFailover, { net: g.net, standby: standby[0].hostname, vip }), "info"));
    }
    if (g.vlan !== undefined && t.redundancy?.stpAlign !== false && active.kind === "switch") {
      redundancy.push(item("redundancy", active.hostname, `show spanning-tree vlan ${g.vlan}`, fmt(p.e.stpRoot, { vlan: g.vlan }), "info"));
    }
  }
  if (t.redundancy?.etherchannel) {
    for (const b of an.bundles) {
      for (const id of [b.a, b.b]) {
        const x = getDevice(t, id);
        if (x) redundancy.push(item("redundancy", x.hostname, "show etherchannel summary", fmt(p.e.bundle, { id: b.id, ports: bundlePorts(b, id).join(", ") }), "info"));
      }
    }
  }
  push("redundancy", redundancy);

  // 6. DHCP
  const dhcp: PlanItem[] = [];
  for (const x of t.devices) {
    const pools = an.dhcp.pools.filter((q) => q.serverId === x.id);
    if (pools.length && (x.kind === "router" || isL3Device(x))) {
      dhcp.push(item("dhcp", x.hostname, "show ip dhcp binding", fmt(p.e.dhcpBinding, { nets: pools.map((q) => q.key).join(", ") }), "info"));
    }
  }
  for (const h of hosts.filter((x) => x.useDhcp)) {
    const i = info(h);
    if (!i?.net) continue;
    const key = netKey(i.net);
    if (i.viaWr) {
      dhcp.push(item("dhcp", h.hostname, "ipconfig", fmt(p.e.dhcpWr, { net: key, gw: intToIp(i.net.ip) }), "info"));
      continue;
    }
    const pool = an.dhcp.pools.find((q) => q.key === key);
    if (pool) {
      dhcp.push(item("dhcp", h.hostname, "ipconfig", fmt(p.e.dhcpClient, { from: intToIp(pool.dynStart), to: intToIp(pool.dynEnd), gw: i.gateway != null ? intToIp(i.gateway) : "?" }), "info"));
    }
  }
  push("dhcp", dhcp);

  // 7. Wi-Fi
  const wifi: PlanItem[] = [];
  for (const l of t.links.filter((x) => x.wireless)) {
    const a = getDevice(t, l.a);
    const b = getDevice(t, l.b);
    const client = a?.wifi ? b : a;
    const radio = a?.wifi ? a : b;
    if (client && radio) wifi.push(item("wifi", client.hostname, "ipconfig", fmt(p.e.wifi, { ssid: radio.wifi?.ssid?.trim() || "?" }), "info"));
  }
  push("wifi", wifi);

  // 8. Internet
  const internet: PlanItem[] = [];
  const targets = t.devices.filter((x) => x.kind === "internet").map((x) => ipToInt(x.testIp ?? "")).filter((v): v is number => v !== null);
  const wrDirect = (h: Device) => {
    const wr = info(h)?.viaWr;
    const q = wr ? peerOf(t, wr.id, "Internet") : null;
    return !!q && getDevice(t, q.deviceId)?.kind === "internet";
  };
  if (targets.length) {
    for (const h of reps) {
      const net = seenNet(h);
      if (!net) continue;
      const cmd = `ping ${intToIp(targets[0])}`;
      const edge = [...an.edges.values()].find((e) => find(`n:${net}`) === find(`d:${e.routerId}`));
      if (edge) {
        const excluded = edge.nat && !edge.inside.some((c) => netKey(c) === net);
        internet.push(item("internet", h.hostname, cmd, excluded ? fmt(p.e.internetNat, { net }) : p.e.internetOk, excluded ? "fail" : "ok"));
      } else if (wrDirect(h)) internet.push(item("internet", h.hostname, cmd, p.e.internetOk, "ok"));
      else internet.push(item("internet", h.hostname, cmd, p.e.internetNoRoute, "fail"));
    }
  }
  for (const e of an.edges.values()) {
    const r = getDevice(t, e.routerId);
    if (r && e.nat) internet.push(item("internet", r.hostname, "show ip nat translations", p.e.nat, "info"));
  }
  push("internet", internet);

  // 9. Security
  const security: PlanItem[] = [];
  for (const id of an.acls.keys()) {
    const x = getDevice(t, id);
    if (x) security.push(item("security", x.hostname, "show access-lists", p.e.acl, "info"));
  }
  if (s.portSecurity) {
    for (const x of t.devices.filter((y) => y.kind === "switch")) {
      const access = connectedPorts(t, x.id).filter((port) => {
        const q = peerOf(t, x.id, port);
        return x.ports[port]?.mode !== "trunk" && x.ports[port]?.mode !== "routed" && (!q || getDevice(t, q.deviceId)?.kind !== "ap");
      });
      if (access.length) security.push(item("security", x.hostname, "show port-security", p.e.portSec, "info"));
    }
  }
  for (const x of t.devices.filter((y) => y.kind === "switch")) {
    const vl = accessVlansOf(t, x);
    if (!vl.length) continue;
    if (s.dhcpSnooping) security.push(item("security", x.hostname, "show ip dhcp snooping", fmt(p.e.snoop, { vlans: vl.join(",") }), "info"));
    if (s.dhcpSnooping && s.dai) security.push(item("security", x.hostname, "show ip arp inspection", fmt(p.e.dai, { vlans: vl.join(",") }), "info"));
    if (s.nativeVlan && connectedPorts(t, x.id).some((port) => x.ports[port]?.mode === "trunk")) {
      security.push(item("security", x.hostname, "show interfaces trunk", fmt(p.e.native, { vlan: Math.floor(s.nativeVlanId) || 999 }), "info"));
    }
  }
  const sshNet = s.sshAcl ? parseCidr(s.sshNet) : null;
  const sshTarget = sshNet ? an.ifaces[0] : undefined;
  if (sshNet && sshTarget) {
    const target = intToIp(sshTarget.cidr.ip);
    const inside = reps.find((h) => {
      const n = hostNet(h);
      return n && n === netKey(sshNet) && joined(n, netKey(sshTarget.cidr));
    });
    const outside = reps.find((h) => { const n = hostNet(h); return n && n !== netKey(sshNet) && joined(n, netKey(sshTarget.cidr)); });
    if (inside) security.push(item("security", inside.hostname, `ssh -l ${s.username} ${target}`, p.e.sshOk, "ok"));
    if (outside) security.push(item("security", outside.hostname, `ssh -l ${s.username} ${target}`, fmt(p.e.sshFail, { net: netKey(sshNet) }), "fail"));
  }
  push("security", security);

  return groups;
}
