import { isL3Device, isL3Switch, isRadioPort } from "./catalog";
import type { Device, Issue, Link, Topology } from "./types";
import {
  type Cidr,
  firstHost,
  lastHost,
  usableHosts,
  intToIp,
  inSameNet,
  isBroadcastAddr,
  isNetworkAddr,
  ipToInt,
  netKey,
  netsOverlap,
  parseCidr,
} from "./net";

export interface RouterIface {
  deviceId: string;
  port: string;
  vlan?: number;
  cidr: Cidr;
  raw: string;
}

export interface StaticRoute {
  net: Cidr;
  nextHop: number;
}

export interface DhcpPoolPlan {
  serverId: string;
  /** "192.168.20.0/24" */
  key: string;
  net: Cidr;
  gateway: number | null;
  dns?: string;
  lease?: number;
  excludeFirst: number;
  excludeLast: number;
  /** Excluded address ranges [from, to]. */
  excluded: [number, number][];
  dynStart: number;
  dynEnd: number;
  /** Addresses actually handed out. */
  count: number;
}

export interface HostNet {
  /** Set when the host is behind a wireless router. */
  viaWr?: Device;
  net: Cidr | null;
  /** Gateway of the host: the configured one, or the gateway found on its network when using DHCP. */
  gateway: number | null;
}

export interface DhcpResult {
  pools: DhcpPoolPlan[];
  /** "deviceId|ifaceKey" -> DHCP server addresses for `ip helper-address`. */
  relays: Map<string, number[]>;
  hosts: Map<string, HostNet>;
}

/** How a border router leaves for Internet. */
export interface EdgePlan {
  routerId: string;
  wanPort: string;
  wanIp: Cidr | null;
  ispId: string;
  ispPort: string;
  /** Address of the ISP side of the link: the next hop of the default route. */
  ispIp: Cidr | null;
  nat: boolean;
  /** Internal networks that leave through NAT. */
  inside: Cidr[];
}

/** What a router or multilayer switch advertises with RIP or OSPF. */
export interface DynPlan {
  protocol: "rip" | "ospf";
  /** Routed networks to announce (the link to the ISP is never announced). */
  networks: Cidr[];
  /** Interfaces that only have users behind them, plus the one toward the ISP. */
  passive: RouterIface[];
  /** Hands its default route to the others (border router). */
  originate: boolean;
  process: number;
  area: number;
}

/** One HSRP group: the shared gateway of a network. */
export interface HsrpPlan {
  /** "192.168.20.0/24" */
  net: string;
  group: number;
  vip: number;
  /** VLAN of the network, when it has one. */
  vlan?: number;
  activeId: string;
  standbyIds: string[];
}

/** Parallel cables between two switches, which EtherChannel can bundle into one link. */
export interface Bundle {
  /** Port-channel number, the same at both ends. */
  id: number;
  a: string;
  b: string;
  links: Link[];
}

/** An extended ACL applied inbound on the gateway interface of a network. */
export interface AclPlan {
  name: string;
  iface: RouterIface;
  rules: { src: Cidr; dst: Cidr }[];
}

export interface Analysis {
  ifaces: RouterIface[];
  routes: Map<string, StaticRoute[]>;
  issues: Issue[];
  dhcp: DhcpResult;
  edges: Map<string, EdgePlan>;
  /** deviceId -> ACLs that keep blocked networks apart. */
  acls: Map<string, AclPlan[]>;
  /** deviceId -> RIP/OSPF configuration. Empty when routing is static. */
  dyn: Map<string, DynPlan>;
  /** "deviceId|interface" -> HSRP settings of that interface. */
  hsrp: Map<string, { group: number; vip: number; priority: number }>;
  hsrpGroups: HsrpPlan[];
  /** Parallel switch-to-switch cables, bundled or not. */
  bundles: Bundle[];
}

/** Virtual gateway address of a network, when it has an HSRP group. */
export function vipFor(t: Topology, key: string): number | null {
  for (const g of t.redundancy?.hsrp ?? []) {
    const n = parseCidr(g.net);
    if (n && netKey(n) === key) return ipToInt(g.vip);
  }
  return null;
}

/** Bundles of parallel cables between two switches. Numbered the same at both ends. */
export function findBundles(t: Topology): Bundle[] {
  const groups = new Map<string, Link[]>();
  for (const l of t.links) {
    if (l.wireless) continue;
    if (getDevice(t, l.a)?.kind !== "switch" || getDevice(t, l.b)?.kind !== "switch") continue;
    const k = l.a < l.b ? `${l.a}|${l.b}` : `${l.b}|${l.a}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  return [...groups.entries()]
    .filter(([, v]) => v.length >= 2)
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([k, links], i) => {
      const [a, b] = k.split("|");
      return { id: i + 1, a, b, links };
    });
}

/** Ports of a device that belong to a bundle. */
export const bundlePorts = (b: Bundle, deviceId: string): string[] =>
  b.links.map((l) => (l.a === deviceId ? l.aPort : l.bPort));

/** Classful network of an address, as RIP wants it: 10.0.12.1 -> 10.0.0.0, 172.16.5.1 -> 172.16.0.0, 192.168.20.1 -> 192.168.20.0. */
export function classfulNet(ip: number): string {
  const first = ip >>> 24;
  const mask = first < 128 ? 0xff000000 : first < 192 ? 0xffff0000 : 0xffffff00;
  return intToIp((ip & mask) >>> 0);
}

/** Canonical form of a pair of networks, so {A,B} and {B,A} are the same rule. */
export const pairOf = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

const DEFAULT_NET: Cidr = { ip: 0, prefix: 0, net: 0 };

/** Key of a routed interface inside `DhcpResult.relays`. Matches the interface names the generator writes. */
export const ifaceKey = (i: { port: string; vlan?: number }) =>
  i.vlan !== undefined && !i.port.startsWith("Vlan") ? `${i.port}.${i.vlan}` : i.port;

export const getDevice = (t: Topology, id: string): Device | undefined =>
  t.devices.find((d) => d.id === id);

/** The device/port on the other end of `port`, if cabled. */
export function peerOf(t: Topology, deviceId: string, port: string) {
  for (const l of t.links) {
    if (l.a === deviceId && l.aPort === port) return { deviceId: l.b, port: l.bPort };
    if (l.b === deviceId && l.bPort === port) return { deviceId: l.a, port: l.aPort };
  }
  return null;
}

export function connectedPorts(t: Topology, deviceId: string): string[] {
  const out: string[] = [];
  for (const l of t.links) {
    if (l.a === deviceId) out.push(l.aPort);
    if (l.b === deviceId) out.push(l.bPort);
  }
  return out;
}

/** IP of an L3 port: router port without subinterfaces, or routed port of a multilayer switch. */
function portIp(d: Device, port: string): Cidr | null {
  const c = d.ports[port];
  if (d.kind === "internet") return parseCidr(c?.ip);
  if (d.kind === "router" && !c?.subifs?.length) return parseCidr(c?.ip);
  if (isL3Switch(d) && c?.mode === "routed") return parseCidr(c.ip);
  return null;
}

/** Every routed interface in the topology: router ports/subinterfaces, SVIs and routed switch ports. */
export function routerIfaces(t: Topology): RouterIface[] {
  const out: RouterIface[] = [];
  for (const d of t.devices) {
    if (isL3Switch(d)) {
      for (const s of d.svis ?? []) {
        const c = parseCidr(s.ip);
        if (c) out.push({ deviceId: d.id, port: `Vlan${s.vlan}`, vlan: s.vlan, cidr: c, raw: s.ip });
      }
      for (const [port, cfg] of Object.entries(d.ports)) {
        const c = cfg.mode === "routed" ? parseCidr(cfg.ip) : null;
        if (c && cfg.ip) out.push({ deviceId: d.id, port, cidr: c, raw: cfg.ip });
      }
      continue;
    }
    if (d.kind !== "router") continue;
    for (const [port, cfg] of Object.entries(d.ports)) {
      if (cfg.subifs?.length) {
        for (const s of cfg.subifs) {
          const c = parseCidr(s.ip);
          if (c) out.push({ deviceId: d.id, port, vlan: s.vlan, cidr: c, raw: s.ip });
        }
      } else {
        const c = parseCidr(cfg.ip);
        if (c && cfg.ip) out.push({ deviceId: d.id, port, cidr: c, raw: cfg.ip });
      }
    }
  }
  return out;
}

/**
 * Static routes for every router: one specific route per remote network,
 * with the next hop being the neighbouring router on the shortest path.
 */
function computeRoutes(t: Topology, ifaces: RouterIface[], issues: Issue[], edges: Map<string, EdgePlan>, dynamic: boolean) {
  const wanKeys = new Set([...edges.values()].flatMap((e) => (e.wanIp ? [netKey(e.wanIp)] : [])));
  const routes = new Map<string, StaticRoute[]>();
  const nets = new Map<string, { cidr: Cidr; routers: Map<string, number> }>();
  for (const i of ifaces) {
    const k = netKey(i.cidr);
    if (!nets.has(k)) nets.set(k, { cidr: i.cidr, routers: new Map() });
    if (!nets.get(k)!.routers.has(i.deviceId)) nets.get(k)!.routers.set(i.deviceId, i.cidr.ip);
  }
  const routers = t.devices.filter(isL3Device);
  const adj = new Map<string, { to: string; key: string }[]>();
  for (const r of routers) adj.set(r.id, []);
  for (const [key, n] of nets) {
    const ids = [...n.routers.keys()];
    for (const a of ids) for (const b of ids) if (a !== b) adj.get(a)!.push({ to: b, key });
  }

  for (const r of routers) {
    const first = new Map<string, { router: string; key: string }>();
    const dist = new Map<string, number>([[r.id, 0]]);
    const queue = [r.id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of adj.get(cur) ?? []) {
        if (dist.has(e.to)) continue;
        dist.set(e.to, dist.get(cur)! + 1);
        first.set(e.to, cur === r.id ? { router: e.to, key: e.key } : first.get(cur)!);
        queue.push(e.to);
      }
    }
    const list: StaticRoute[] = [];
    const sorted = [...nets.entries()].sort((x, y) => x[1].cidr.net - y[1].cidr.net);
    for (const [key, n] of sorted) {
      if (n.routers.has(r.id)) continue;
      // The link to the ISP is reached through the default route, not through specific routes.
      if (wanKeys.has(key)) continue;
      let best: string | null = null;
      for (const id of n.routers.keys()) {
        if (!dist.has(id)) continue;
        if (best === null || dist.get(id)! < dist.get(best)!) best = id;
      }
      if (best === null) {
        issues.push({
          level: "warn",
          code: "noRoute",
          args: { dev: r.hostname, net: netKey(n.cidr) },
        });
        continue;
      }
      const hop = first.get(best)!;
      const hopIp = nets.get(hop.key)!.routers.get(hop.router)!;
      list.push({ net: n.cidr, nextHop: hopIp });
    }
    // Default route: the border router uses its ISP; everyone else goes toward the nearest border router.
    const mine = edges.get(r.id);
    if (mine) {
      if (mine.ispIp) list.push({ net: DEFAULT_NET, nextHop: mine.ispIp.ip });
    } else if (edges.size) {
      let best: string | null = null;
      for (const id of edges.keys()) {
        if (dist.has(id) && (best === null || dist.get(id)! < dist.get(best)!)) best = id;
      }
      if (best === null) {
        issues.push({ level: "warn", code: "noDefault", args: { dev: r.hostname } });
      } else {
        const hop = first.get(best)!;
        list.push({ net: DEFAULT_NET, nextHop: nets.get(hop.key)!.routers.get(hop.router)! });
      }
    }
    // With RIP or OSPF the routers learn the networks themselves; only the border router keeps its default route.
    routes.set(r.id, dynamic ? list.filter((x) => x.net.prefix === 0 && edges.has(r.id)) : list);
  }
  return routes;
}

/** Border routers: which port leaves for Internet, the ISP address and the networks that get NAT. */
function computeEdges(t: Topology, ifaces: RouterIface[], issues: Issue[]): Map<string, EdgePlan> {
  const edges = new Map<string, EdgePlan>();
  const found: { r: Device; wan: string; peerPort: string; isp: Device }[] = [];
  for (const r of t.devices) {
    if (r.kind !== "router" || !r.edge?.enabled) continue;
    const wan = r.edge.wanPort;
    const peer = wan ? peerOf(t, r.id, wan) : null;
    const isp = peer ? getDevice(t, peer.deviceId) : undefined;
    if (!wan || !peer || isp?.kind !== "internet" || r.ports[wan]?.subifs?.length) {
      issues.push({ level: "warn", code: "edgeNoWan", args: { dev: r.hostname } });
      continue;
    }
    found.push({ r, wan, peerPort: peer.port, isp });
  }
  const wanKeys = new Set(found.flatMap((f) => { const c = portIp(f.r, f.wan); return c ? [netKey(c)] : []; }));
  for (const { r, wan, peerPort, isp } of found) {
    const wanIp = portIp(r, wan);
    const ispIp = parseCidr(isp.ports[peerPort]?.ip);
    if (!ispIp) issues.push({ level: "warn", code: "edgeIspNoIp", args: { dev: isp.hostname, port: peerPort } });
    const exclude = new Set(r.edge!.natExclude ?? []);
    const seen = new Set<string>();
    const inside: Cidr[] = [];
    for (const i of ifaces) {
      const k = netKey(i.cidr);
      if (i.cidr.prefix > 29 || wanKeys.has(k) || exclude.has(k) || seen.has(k)) continue;
      seen.add(k);
      inside.push(i.cidr);
    }
    inside.sort((a, b) => a.net - b.net);
    edges.set(r.id, { routerId: r.id, wanPort: wan, wanIp, ispId: isp.id, ispPort: peerPort, ispIp, nat: r.edge!.nat !== false, inside });
  }
  // An Internet node cabled to a router that is not set up as border router.
  for (const l of t.links) {
    for (const [id, port, other] of [[l.a, l.aPort, l.b], [l.b, l.bPort, l.a]] as const) {
      const dev = getDevice(t, id);
      const o = getDevice(t, other);
      if (dev?.kind === "router" && o?.kind === "internet" && !(dev.edge?.enabled && dev.edge.wanPort === port)) {
        issues.push({ level: "warn", code: "ispNotEdge", args: { dev: dev.hostname, isp: o.hostname } });
      }
    }
  }
  return edges;
}

/** VLAN id and name of each network that belongs to a VLAN (subinterface or SVI), to label it "192.168.20.0/24 (VLAN 20 · PCs)". */
export function networkTags(t: Topology): Map<string, { vlan?: number; name?: string }> {
  const names = new Map<number, string>();
  for (const d of t.devices) {
    for (const v of d.vlans ?? []) if (v.name?.trim() && !names.has(v.id)) names.set(v.id, v.name.trim());
  }
  const out = new Map<string, { vlan?: number; name?: string }>();
  for (const i of routerIfaces(t)) {
    const key = netKey(i.cidr);
    if (i.vlan !== undefined && !out.has(key)) out.set(key, { vlan: i.vlan, name: names.get(i.vlan) });
  }
  return out;
}

/** Networks of the topology that users sit in: every routed network except point-to-point links and the ISP link. */
export function lanNetworks(t: Topology): { key: string; cidr: Cidr; vlan?: number; name?: string }[] {
  const tags = networkTags(t);
  const wan = new Set<string>();
  for (const r of t.devices) {
    const w = r.kind === "router" && r.edge?.enabled && r.edge.wanPort ? portIp(r, r.edge.wanPort) : null;
    if (w) wan.add(netKey(w));
  }
  const out = new Map<string, { key: string; cidr: Cidr; vlan?: number; name?: string }>();
  for (const i of routerIfaces(t)) {
    const key = netKey(i.cidr);
    if (i.cidr.prefix > 29 || wan.has(key)) continue;
    out.set(key, { key, cidr: i.cidr, ...tags.get(key) });
  }
  return [...out.values()].sort((a, b) => a.cidr.net - b.cidr.net);
}

/** ACLs for the blocked pairs: each side of a pair denies the other, on the gateway of its own network. */
function computePolicy(t: Topology, ifaces: RouterIface[], dhcp: DhcpResult, issues: Issue[]): Map<string, AclPlan[]> {
  const acls = new Map<string, AclPlan[]>();
  if (!t.policy?.enabled) return acls;
  const nets = new Map(lanNetworks(t).map((n) => [n.key, n.cidr]));
  const blocked = new Set<string>();
  for (const [x, y] of t.policy.blocked) {
    const a = nets.get(x);
    const b = nets.get(y);
    if (!a || !b) {
      issues.push({ level: "warn", code: "policyNoNet", args: { net: nets.has(x) ? y : x } });
      continue;
    }
    blocked.add(pairOf(x, y).join("|"));
    for (const [src, dst] of [[a, b], [b, a]] as const) {
      for (const i of ifaces.filter((f) => netKey(f.cidr) === netKey(src))) {
        const list = acls.get(i.deviceId) ?? [];
        let plan = list.find((p) => p.iface === i);
        if (!plan) {
          plan = { name: `BLOCK_${intToIp(src.net).replace(/\./g, "_")}`, iface: i, rules: [] };
          list.push(plan);
          acls.set(i.deviceId, list);
        }
        if (!plan.rules.some((r) => r.src.net === src.net && r.dst.net === dst.net)) plan.rules.push({ src, dst });
      }
    }
  }
  // A DHCP server (a Server device) in a blocked network cannot answer relayed requests from the other one.
  for (const p of dhcp.pools) {
    const s = getDevice(t, p.serverId);
    const sc = s?.kind === "server" ? parseCidr(s.ip) : null;
    if (!sc) continue;
    const from = netKey({ ...sc, net: sc.net });
    if (from !== p.key && blocked.has(pairOf(from, p.key).join("|"))) {
      issues.push({ level: "warn", code: "policyBlocksDhcp", args: { pool: p.key, server: from } });
    }
  }
  return acls;
}

/** Networks a border router could send out through NAT (point-to-point links and the WAN link excluded). */
export function edgeNetworks(t: Topology, routerId: string): Cidr[] {
  const ifaces = routerIfaces(t);
  const r = getDevice(t, routerId);
  const wan = r?.edge?.wanPort;
  const wanIp = r && wan ? portIp(r, wan) : null;
  const seen = new Map<string, Cidr>();
  for (const i of ifaces) {
    const k = netKey(i.cidr);
    if (i.cidr.prefix <= 29 && (!wanIp || k !== netKey(wanIp))) seen.set(k, i.cidr);
  }
  return [...seen.values()].sort((a, b) => a.net - b.net);
}

/**
 * Everything reachable at layer 2 from a host: router addresses in the same
 * broadcast domain and other hosts. Follows access/trunk ports and VLAN ids.
 */
export function l2Segment(t: Topology, host: Device) {
  const routerIps = new Set<number>();
  const hosts = new Set<string>();
  let vlan: number | undefined;
  /** Set when the host sits behind a wireless router: its LAN is a separate network of its own. */
  let wrLan: { cidr: Cidr; dev: Device } | null = null;
  const result = () => {
    // A network with HSRP answers on its virtual address too, and that is the one hosts use.
    for (const g of t.redundancy?.hsrp ?? []) {
      const n = parseCidr(g.net);
      const v = ipToInt(g.vip);
      if (n && v !== null && [...routerIps].some((ip) => inSameNet(n, ip))) routerIps.add(v);
    }
    return { routerIps, hosts, vlan, wrLan };
  };
  const visited = new Set<string>();
  const stack: { sw: string; vlan: number }[] = [];

  const reachPeer = (peerDev: string, peerPort: string, v: number | null) => {
    const p = getDevice(t, peerDev);
    if (!p) return;
    if (p.kind === "pc" || p.kind === "server") {
      if (p.id !== host.id) hosts.add(p.id);
    } else if (isL3Switch(p)) {
      // Only reached through a routed port; VLAN-aware SVIs are handled in the traversal.
      const c = p.ports[peerPort]?.mode === "routed" ? parseCidr(p.ports[peerPort]?.ip) : null;
      if (c && v === null) routerIps.add(c.ip);
    } else if (p.kind === "internet") {
      const c = parseCidr(p.ports[peerPort]?.ip);
      if (c && v === null) routerIps.add(c.ip);
    } else if (p.kind === "router") {
      const cfg = p.ports[peerPort];
      if (v === null) {
        const c = parseCidr(cfg?.ip);
        if (c && !cfg?.subifs?.length) routerIps.add(c.ip);
      } else {
        for (const s of cfg?.subifs ?? []) {
          const c = parseCidr(s.ip);
          if (c && s.vlan === v) routerIps.add(c.ip);
        }
      }
    }
  };

  // A wireless router reaches the network through its "Internet" port; any other host uses its first cable.
  const hostPort = host.kind === "wrouter" ? "Internet" : (Object.keys(host.ports)[0] ?? connectedPorts(t, host.id)[0]);
  let first = hostPort ? peerOf(t, host.id, hostPort) : null;
  let fp = first ? getDevice(t, first.deviceId) : undefined;
  // An access point is transparent: follow its cable to the switch behind it.
  for (let hop = 0; fp && fp.kind === "ap" && hop < 4; hop++) {
    const wired = connectedPorts(t, fp.id).find((p) => !isRadioPort(p));
    first = wired ? peerOf(t, fp.id, wired) : null;
    fp = first ? getDevice(t, first.deviceId) : undefined;
  }
  if (!first || !fp) return result();
  if (fp.kind === "wrouter" && first.port !== "Internet") {
    const lan = parseCidr(fp.wr?.lanIp);
    if (lan) {
      routerIps.add(lan.ip);
      wrLan = { cidr: lan, dev: fp };
    }
    return result();
  }
  if (fp.kind !== "switch" || fp.ports[first.port]?.mode === "routed") {
    reachPeer(first.deviceId, first.port, null);
    return result();
  }
  const cfg = fp.ports[first.port];
  vlan = cfg?.mode === "trunk" ? 1 : cfg?.vlan ?? 1;
  stack.push({ sw: fp.id, vlan });

  while (stack.length) {
    const { sw, vlan: v } = stack.pop()!;
    const key = `${sw}:${v}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const s = getDevice(t, sw)!;
    if (isL3Switch(s)) {
      // A multilayer switch is itself the gateway of every VLAN it has an SVI for.
      for (const svi of s.svis ?? []) {
        const c = parseCidr(svi.ip);
        if (c && svi.vlan === v) routerIps.add(c.ip);
      }
    }
    for (const port of connectedPorts(t, sw)) {
      const pc = s.ports[port] ?? {};
      if (pc.mode === "routed") continue;
      const peer = peerOf(t, sw, port)!;
      const peerDev = getDevice(t, peer.deviceId);
      if (!peerDev) continue;
      if (pc.mode === "trunk") {
        if (peerDev.kind === "switch") {
          if (peerDev.ports[peer.port]?.mode === "trunk") stack.push({ sw: peerDev.id, vlan: v });
        } else {
          reachPeer(peer.deviceId, peer.port, v);
        }
      } else if ((pc.vlan ?? 1) === v) {
        if (peerDev.kind === "switch") {
          const pp = peerDev.ports[peer.port];
          if (pp?.mode === "routed") reachPeer(peer.deviceId, peer.port, null);
          else if (pp?.mode !== "trunk") stack.push({ sw: peerDev.id, vlan: pp?.vlan ?? 1 });
        } else {
          reachPeer(peer.deviceId, peer.port, null);
        }
      }
    }
  }
  return result();
}

export function analyze(t: Topology): Analysis {
  const issues: Issue[] = [];
  const ifaces = routerIfaces(t);

  // --- syntax of every IP the user typed
  const seenIps = new Map<number, string>();
  const claim = (ip: Cidr | null, owner: string) => {
    if (!ip) return;
    const prev = seenIps.get(ip.ip);
    if (prev) {
      issues.push({ level: "error", code: "dupIp", args: { ip: intToIp(ip.ip), a: prev, b: owner } });
    } else seenIps.set(ip.ip, owner);
    if (isNetworkAddr(ip) || isBroadcastAddr(ip)) {
      issues.push({ level: "error", code: "reservedIp", args: { ip: intToIp(ip.ip), dev: owner } });
    }
  };
  const checkIp = (value: string | undefined, owner: string, where: string) => {
    if (!value?.trim()) return null;
    const c = parseCidr(value);
    if (!c) issues.push({ level: "error", code: "badIp", args: { dev: owner, where, value } });
    return c;
  };

  const names = new Map<string, number>();
  for (const d of t.devices) {
    names.set(d.hostname, (names.get(d.hostname) ?? 0) + 1);
    if (d.kind === "router") {
      for (const [port, cfg] of Object.entries(d.ports)) {
        if (cfg.subifs?.length) {
          if (cfg.ip) issues.push({ level: "warn", code: "subAndIp", args: { dev: d.hostname, port } });
          for (const s of cfg.subifs) {
            claim(checkIp(s.ip, d.hostname, `${port}.${s.vlan}`), `${d.hostname} ${port}.${s.vlan}`);
          }
        } else {
          claim(checkIp(cfg.ip, d.hostname, port), `${d.hostname} ${port}`);
        }
      }
    } else if (isL3Switch(d)) {
      const defined = new Set((d.vlans ?? []).map((v) => v.id));
      for (const s of d.svis ?? []) {
        claim(checkIp(s.ip, d.hostname, `vlan ${s.vlan}`), `${d.hostname} Vlan${s.vlan}`);
        if (s.vlan !== 1 && !defined.has(s.vlan)) {
          issues.push({ level: "warn", code: "vlanUndefined", args: { dev: d.hostname, vlan: s.vlan } });
        }
      }
      for (const [port, cfg] of Object.entries(d.ports)) {
        if (cfg.mode === "routed") claim(checkIp(cfg.ip, d.hostname, port), `${d.hostname} ${port}`);
      }
    } else if (d.kind === "switch") {
      if (d.mgmt) claim(checkIp(d.mgmt.ip, d.hostname, "mgmt"), `${d.hostname} VLAN ${d.mgmt.vlan}`);
    } else if (d.kind === "internet") {
      for (const [port, cfg] of Object.entries(d.ports)) {
        claim(checkIp(cfg.ip, d.hostname, port), `${d.hostname} ${port}`);
      }
    } else if (d.kind === "ap") {
      // An access point has no address of its own in this tool.
    } else if (!d.useDhcp || d.kind === "wrouter") {
      if (d.kind === "wrouter") claim(checkIp(d.wr?.lanIp, d.hostname, "LAN"), `${d.hostname} LAN`);
      if (d.useDhcp) continue;
      claim(checkIp(d.ip, d.hostname, "IP"), d.hostname);
    }
  }
  for (const [name, n] of names) {
    if (n > 1) issues.push({ level: "warn", code: "dupName", args: { name } });
  }
  // A virtual gateway address must not belong to anything else.
  for (const g of t.redundancy?.hsrp ?? []) {
    const n = parseCidr(g.net);
    const c = n ? parseCidr(`${g.vip}/${n.prefix}`) : null;
    if (c) claim(c, `HSRP ${g.net}`);
  }

  // --- overlapping subnets with different masks
  const keys = new Map<string, Cidr>();
  for (const i of ifaces) keys.set(netKey(i.cidr), i.cidr);
  const arr = [...keys.entries()];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      if (netsOverlap(arr[i][1], arr[j][1])) {
        issues.push({ level: "error", code: "overlap", args: { a: arr[i][0], b: arr[j][0] } });
      }
    }
  }

  // --- per-link checks
  for (const l of t.links) {
    const A = getDevice(t, l.a);
    const B = getDevice(t, l.b);
    if (!A || !B) continue;
    for (const [X, xp, Y, yp] of [
      [A, l.aPort, B, l.bPort],
      [B, l.bPort, A, l.aPort],
    ] as const) {
      if (isL3Switch(X) && X.ports[xp]?.mode === "routed" && !X.ports[xp]?.ip?.trim()) {
        issues.push({ level: "warn", code: "portNoIp", args: { dev: X.hostname, port: xp } });
      }
      if (X.kind !== "router") continue;
      const cfg = X.ports[xp] ?? {};
      const hasSub = !!cfg.subifs?.length;
      const yCfg = Y.ports[yp] ?? {};
      if (!hasSub && !cfg.ip) {
        issues.push({ level: "warn", code: "portNoIp", args: { dev: X.hostname, port: xp } });
      }
      if (Y.kind === "switch") {
        if (yCfg.mode === "trunk" && !hasSub) {
          issues.push(
            isL3Switch(Y)
              ? { level: "warn", code: "trunkL3", args: { dev: X.hostname, port: xp, peer: Y.hostname, peerPort: yp } }
              : { level: "warn", code: "trunkNoSub", args: { dev: X.hostname, port: xp } },
          );
        }
        if (yCfg.mode !== "trunk" && hasSub) {
          issues.push({ level: "error", code: "subOnAccess", args: { dev: X.hostname, port: xp } });
        }
      } else if (hasSub) {
        issues.push({ level: "error", code: "subNoSwitch", args: { dev: X.hostname, port: xp } });
      }
      if (hasSub && Y.kind === "switch") {
        const defined = new Set((Y.vlans ?? []).map((v) => v.id));
        for (const s of cfg.subifs!) {
          if (!defined.has(s.vlan)) {
            issues.push({
              level: "warn",
              code: "vlanUndefined",
              args: { dev: Y.hostname, vlan: s.vlan },
            });
          }
        }
      }
    }
    {
      // Point-to-point link between two L3 ports (router or routed switch port).
      const a = portIp(A, l.aPort);
      const b = portIp(B, l.bPort);
      if (a && b && (a.net !== b.net || a.prefix !== b.prefix)) {
        issues.push({
          level: "error",
          code: "p2pMismatch",
          args: { a: `${A.hostname} ${l.aPort}`, b: `${B.hostname} ${l.bPort}` },
        });
      }
    }
    if (A.kind === "switch" && B.kind === "switch") {
      const am = A.ports[l.aPort]?.mode === "trunk";
      const bm = B.ports[l.bPort]?.mode === "trunk";
      const routed = A.ports[l.aPort]?.mode === "routed" || B.ports[l.bPort]?.mode === "routed";
      if (am !== bm && !routed) {
        issues.push({ level: "warn", code: "trunkMismatch", args: { a: A.hostname, b: B.hostname } });
      }
    }
  }

  // --- switch VLAN consistency
  for (const d of t.devices) {
    if (d.kind !== "switch") continue;
    const defined = new Set((d.vlans ?? []).map((v) => v.id));
    for (const port of connectedPorts(t, d.id)) {
      const c = d.ports[port];
      if (c?.mode !== "trunk" && c?.vlan && c.vlan !== 1 && !defined.has(c.vlan)) {
        issues.push({ level: "warn", code: "vlanUndefined", args: { dev: d.hostname, vlan: c.vlan } });
      }
    }
  }

  // --- Internet
  const edges = computeEdges(t, ifaces, issues);

  // --- DHCP
  const dhcp = computeDhcp(t, ifaces, issues);

  // --- hosts
  const hasRouter = t.devices.some(isL3Device);
  for (const h of t.devices) {
    if (h.kind !== "pc" && h.kind !== "server" && h.kind !== "wrouter") continue;
    if (h.useDhcp) {
      if (!connectedPorts(t, h.id).length) {
        issues.push({ level: "warn", code: "hostNoLink", args: { dev: h.hostname } });
        continue;
      }
      const info = dhcp.hosts.get(h.id);
      if (!info?.net) {
        issues.push({ level: "error", code: "dhcpNoGw", args: { dev: h.hostname } });
      } else if (info.viaWr) {
        if (!info.viaWr.wr?.dhcp) issues.push({ level: "error", code: "dhcpNoServer", args: { dev: h.hostname, net: netKey(info.net) } });
      } else if (!dhcp.pools.some((p) => p.key === netKey(info.net!))) {
        issues.push({ level: "error", code: "dhcpNoServer", args: { dev: h.hostname, net: netKey(info.net) } });
      }
      continue;
    }
    const ip = parseCidr(h.ip);
    if (!h.ip?.trim()) {
      issues.push({ level: "warn", code: "hostNoIp", args: { dev: h.hostname } });
      continue;
    }
    if (!ip) continue;
    if (!connectedPorts(t, h.id).length) {
      issues.push({ level: "warn", code: "hostNoLink", args: { dev: h.hostname } });
      continue;
    }
    const gw = ipToInt(h.gateway ?? "");
    if (!h.gateway?.trim()) {
      if (hasRouter) issues.push({ level: "warn", code: "hostNoGw", args: { dev: h.hostname } });
      continue;
    }
    if (gw === null) {
      issues.push({ level: "error", code: "badIp", args: { dev: h.hostname, where: "gateway", value: h.gateway } });
      continue;
    }
    if (!inSameNet(ip, gw)) {
      issues.push({
        level: "error",
        code: "gwOutside",
        args: { dev: h.hostname, gw: h.gateway, net: netKey(ip) },
      });
      continue;
    }
    const seg = l2Segment(t, h);
    if (!seg.routerIps.has(gw)) {
      issues.push({ level: "error", code: "gwNotInL2", args: { dev: h.hostname, gw: h.gateway } });
    }
  }

  // --- Wi-Fi: access points and wireless routers
  checkWifi(t, ifaces, issues);

  const dynamic = !!t.routing && t.routing.protocol !== "static";
  const routes = computeRoutes(t, ifaces, issues, edges, dynamic);
  const dyn = computeDynamic(t, ifaces, edges, issues);
  const acls = computePolicy(t, ifaces, dhcp, issues);
  const { hsrp, hsrpGroups } = computeHsrp(t, ifaces, issues);
  const bundles = computeBundles(t, issues);
  return { ifaces, routes, issues, dhcp, edges, acls, dyn, hsrp, hsrpGroups, bundles };
}

/** HSRP: two devices share the gateway address of a network, one answers (active) and the other waits. */
function computeHsrp(t: Topology, ifaces: RouterIface[], issues: Issue[]) {
  const hsrp = new Map<string, { group: number; vip: number; priority: number }>();
  const hsrpGroups: HsrpPlan[] = [];
  const tags = networkTags(t);
  const used = new Map<number, string>();
  (t.redundancy?.hsrp ?? []).forEach((g, idx) => {
    const net = parseCidr(g.net);
    if (!net) {
      issues.push({ level: "error", code: "badIp", args: { dev: "HSRP", where: "net", value: g.net } });
      return;
    }
    const key = netKey(net);
    const members = ifaces.filter((i) => netKey(i.cidr) === key);
    const devs = [...new Set(members.map((m) => m.deviceId))];
    if (devs.length < 2) {
      issues.push({ level: "warn", code: "hsrpSingle", args: { net: key } });
      return;
    }
    const vip = ipToInt(g.vip);
    if (vip === null || !inSameNet(net, vip)) {
      issues.push({ level: "error", code: "hsrpBadVip", args: { net: key, vip: g.vip } });
      return;
    }
    if (members.some((m) => m.cidr.ip === vip)) {
      issues.push({ level: "error", code: "hsrpVipTaken", args: { ip: g.vip, net: key } });
      return;
    }
    const vlan = tags.get(key)?.vlan;
    const group = g.group ?? (vlan !== undefined && vlan <= 255 ? vlan : idx + 1);
    if (used.has(group)) issues.push({ level: "warn", code: "hsrpGroupDup", args: { group, a: used.get(group)!, b: key } });
    used.set(group, key);
    const activeId = g.active && devs.includes(g.active) ? g.active : devs[0];
    for (const m of members) {
      hsrp.set(`${m.deviceId}|${ifaceKey(m)}`, { group, vip, priority: m.deviceId === activeId ? 110 : 100 });
    }
    hsrpGroups.push({ net: key, group, vip, vlan, activeId, standbyIds: devs.filter((d) => d !== activeId) });
  });
  return { hsrp, hsrpGroups };
}

/** Parallel cables: warn when they are not bundled (spanning tree would block all but one). */
function computeBundles(t: Topology, issues: Issue[]): Bundle[] {
  const bundles = findBundles(t);
  const on = !!t.redundancy?.etherchannel;
  for (const b of bundles) {
    const A = getDevice(t, b.a)!;
    const B = getDevice(t, b.b)!;
    if (!on) {
      issues.push({ level: "warn", code: "parallelNoChannel", args: { a: A.hostname, b: B.hostname, n: b.links.length } });
      continue;
    }
    if (b.links.length > 8) issues.push({ level: "error", code: "bundleTooBig", args: { a: A.hostname, b: B.hostname } });
    for (const dev of [A, B]) {
      const cfgs = bundlePorts(b, dev.id).map((p) => dev.ports[p] ?? {});
      const same = cfgs.every((c) => (c.mode ?? "access") === (cfgs[0].mode ?? "access") && (c.vlan ?? 1) === (cfgs[0].vlan ?? 1));
      if (!same) issues.push({ level: "warn", code: "bundleMismatch", args: { dev: dev.hostname } });
    }
  }
  return bundles;
}

/** Networks where two or more routers or multilayer switches have an interface: candidates for HSRP. */
export function hsrpCandidates(t: Topology) {
  const tags = networkTags(t);
  const byNet = new Map<string, { key: string; cidr: Cidr; vlan?: number; name?: string; devices: Device[] }>();
  for (const i of routerIfaces(t)) {
    if (i.cidr.prefix > 29) continue;
    const key = netKey(i.cidr);
    const dev = getDevice(t, i.deviceId);
    if (!dev) continue;
    const e = byNet.get(key) ?? { key, cidr: i.cidr, ...tags.get(key), devices: [] };
    if (!e.devices.some((d) => d.id === dev.id)) e.devices.push(dev);
    byNet.set(key, e);
  }
  return [...byNet.values()].filter((e) => e.devices.length >= 2).sort((a, b) => a.cidr.net - b.cidr.net);
}

/** RIPv2 / OSPF: which networks each router announces, which interfaces stay silent, who hands out the default route. */
function computeDynamic(t: Topology, ifaces: RouterIface[], edges: Map<string, EdgePlan>, issues: Issue[]): Map<string, DynPlan> {
  const out = new Map<string, DynPlan>();
  const cfg = t.routing;
  if (!cfg || cfg.protocol === "static") return out;
  const protocol = cfg.protocol;
  const wanKeys = new Set([...edges.values()].flatMap((e) => (e.wanIp ? [netKey(e.wanIp)] : [])));
  const process = Math.max(1, Math.floor(cfg.ospfProcess ?? 1));
  const area = Math.max(0, Math.floor(cfg.ospfArea ?? 0));
  const routers = t.devices.filter(isL3Device);
  if (routers.length < 2) issues.push({ level: "warn", code: "dynSingle", args: {} });
  const originate = cfg.originate !== false;

  for (const d of routers) {
    const mine = ifaces.filter((i) => i.deviceId === d.id);
    const nets = new Map<string, Cidr>();
    for (const i of mine) if (!wanKeys.has(netKey(i.cidr))) nets.set(netKey(i.cidr), i.cidr);
    if (!nets.size) continue;
    const passive: RouterIface[] = [];
    for (const i of mine) {
      const key = netKey(i.cidr);
      if (wanKeys.has(key)) {
        passive.push(i);
        continue;
      }
      // No other router on this network: nobody to talk to, so keep updates off it.
      const hasNeighbor = ifaces.some((j) => j.deviceId !== d.id && netKey(j.cidr) === key);
      if (cfg.passive !== false && !hasNeighbor) passive.push(i);
    }
    out.set(d.id, {
      protocol,
      networks: [...nets.values()].sort((a, b) => a.net - b.net),
      passive,
      originate: originate && edges.has(d.id),
      process,
      area,
    });
    if (edges.size && !originate && !edges.has(d.id)) {
      issues.push({ level: "warn", code: "dynNoDefault", args: { dev: d.hostname } });
    }
  }
  return out;
}

function checkWifi(t: Topology, ifaces: RouterIface[], issues: Issue[]) {
  const lans: { dev: Device; cidr: Cidr }[] = [];
  for (const d of t.devices) {
    if (d.kind !== "ap" && d.kind !== "wrouter") continue;
    if (!d.wifi?.ssid?.trim()) issues.push({ level: "warn", code: "wifiNoSsid", args: { dev: d.hostname } });
    if (d.wifi?.security === "wpa2" && (d.wifi.passphrase ?? "").length < 8) {
      issues.push({ level: "warn", code: "wifiShortKey", args: { dev: d.hostname } });
    }
    if (d.kind === "ap") {
      const wired = connectedPorts(t, d.id).filter((p) => !isRadioPort(p));
      if (!wired.length) issues.push({ level: "warn", code: "apNoUplink", args: { dev: d.hostname } });
      for (const p of wired) {
        const q = peerOf(t, d.id, p);
        const sw = q && getDevice(t, q.deviceId);
        if (sw?.kind === "switch" && sw.ports[q!.port]?.mode === "trunk") {
          issues.push({ level: "warn", code: "apTrunk", args: { dev: d.hostname, sw: sw.hostname, port: q!.port } });
        }
      }
      continue;
    }
    const lan = parseCidr(d.wr?.lanIp);
    if (!lan) {
      issues.push({ level: "warn", code: "wrNoLan", args: { dev: d.hostname } });
      continue;
    }
    lans.push({ dev: d, cidr: lan });
    if (d.wr?.dhcp) {
      const start = lan.net + (d.wr.dhcpStart ?? 100);
      const end = start + (d.wr.maxUsers ?? 50) - 1;
      if (start < firstHost(lan) || end > lastHost(lan)) {
        issues.push({ level: "warn", code: "wrRange", args: { dev: d.hostname, net: netKey(lan) } });
      } else if (lan.ip >= start && lan.ip <= end) {
        issues.push({ level: "warn", code: "wrRangeIp", args: { dev: d.hostname, ip: intToIp(lan.ip) } });
      }
    }
  }
  // The LAN of a wireless router must not collide with any routed network or with another wireless LAN.
  lans.forEach((a, i) => {
    for (const f of ifaces) {
      if (netsOverlap(a.cidr, f.cidr)) {
        issues.push({ level: "error", code: "overlap", args: { a: `${netKey(a.cidr)} (${a.dev.hostname})`, b: netKey(f.cidr) } });
        break;
      }
    }
    for (const b of lans.slice(i + 1)) {
      if (netsOverlap(a.cidr, b.cidr)) {
        issues.push({ level: "error", code: "overlap", args: { a: `${netKey(a.cidr)} (${a.dev.hostname})`, b: `${netKey(b.cidr)} (${b.dev.hostname})` } });
      }
    }
  });
}

/** Network and gateway of a host: fixed settings, or (with DHCP) the gateway found in its layer-2 segment. */
export function hostNetwork(t: Topology, ifaces: RouterIface[], h: Device): HostNet {
  if (!h.useDhcp) {
    const c = parseCidr(h.ip);
    return { net: c, gateway: ipToInt(h.gateway ?? "") };
  }
  const seg = l2Segment(t, h);
  // Behind a wireless router: its own LAN and its own DHCP server.
  if (seg.wrLan) return { net: seg.wrLan.cidr, gateway: seg.wrLan.cidr.ip, viaWr: seg.wrLan.dev };
  for (const ip of [...seg.routerIps].sort((a, b) => a - b)) {
    const i = ifaces.find((x) => x.cidr.ip === ip);
    if (i) return { net: i.cidr, gateway: vipFor(t, netKey(i.cidr)) ?? ip };
  }
  return { net: null, gateway: null };
}

function computeDhcp(t: Topology, ifaces: RouterIface[], issues: Issue[]): DhcpResult {
  const pools: DhcpPoolPlan[] = [];
  const relays = new Map<string, number[]>();
  const hosts = new Map<string, HostNet>();
  for (const h of t.devices) {
    if (h.kind === "pc" || h.kind === "server" || h.kind === "wrouter") hosts.set(h.id, hostNetwork(t, ifaces, h));
  }

  // Fixed addresses that must not fall inside a range that is handed out.
  const fixed: { ip: number; owner: string }[] = [];
  for (const i of ifaces) fixed.push({ ip: i.cidr.ip, owner: `${getDevice(t, i.deviceId)?.hostname} ${i.port}` });
  for (const d of t.devices) {
    if ((d.kind === "pc" || d.kind === "server" || d.kind === "wrouter") && !d.useDhcp) {
      const c = parseCidr(d.ip);
      if (c) fixed.push({ ip: c.ip, owner: d.hostname });
    }
    const m = d.kind === "switch" && d.mgmt ? parseCidr(d.mgmt.ip) : null;
    if (m) fixed.push({ ip: m.ip, owner: d.hostname });
  }

  const seen = new Map<string, string>();
  for (const s of t.devices) {
    if (!s.dhcpServer?.enabled || !s.dhcpServer.pools.length) continue;
    if (!(s.kind === "server" || s.kind === "router" || isL3Switch(s))) {
      issues.push({ level: "warn", code: "dhcpServerL2", args: { dev: s.hostname } });
      continue;
    }
    const sCidr = s.kind === "server" ? parseCidr(s.ip) : null;
    if (s.kind === "server" && (!sCidr || s.useDhcp)) {
      issues.push({ level: "warn", code: "dhcpServerNoIp", args: { dev: s.hostname } });
      continue;
    }
    for (const p of s.dhcpServer.pools) {
      const net = parseCidr(p.net);
      if (!net) {
        issues.push({ level: "error", code: "badIp", args: { dev: s.hostname, where: "DHCP", value: p.net } });
        continue;
      }
      const key = netKey(net);
      const inNet = ifaces.filter((i) => netKey(i.cidr) === key);
      if (!inNet.length) {
        issues.push({ level: "warn", code: "dhcpPoolNoNet", args: { dev: s.hostname, net: key } });
        continue;
      }
      if (seen.has(key)) {
        issues.push({ level: "warn", code: "dhcpDup", args: { net: key, a: seen.get(key)!, b: s.hostname } });
        continue;
      }
      seen.set(key, s.hostname);

      let gateway: number | null = null;
      if (p.gateway?.trim()) {
        gateway = ipToInt(p.gateway);
        if (gateway === null || !inSameNet(net, gateway)) {
          issues.push({ level: "error", code: "gwOutside", args: { dev: s.hostname, gw: p.gateway, net: key } });
          gateway = null;
        }
      }
      if (gateway === null) gateway = vipFor(t, key) ?? (inNet.find((i) => i.deviceId === s.id) ?? inNet[0]).cidr.ip;

      const usable = usableHosts(net);
      const exF = Math.min(usable, Math.max(0, Math.floor(p.excludeFirst ?? 10)));
      const exL = Math.min(usable, Math.max(0, Math.floor(p.excludeLast ?? 0)));
      const first = firstHost(net);
      const last = lastHost(net);
      const dynStart = first + exF;
      const dynEnd = last - exL;
      const count = Math.max(0, dynEnd - dynStart + 1);
      const excluded: [number, number][] = [];
      if (exF > 0) excluded.push([first, Math.min(last, first + exF - 1)]);
      if (exL > 0 && exL + exF <= usable) excluded.push([last - exL + 1, last]);
      if (count === 0) issues.push({ level: "error", code: "dhcpExhausted", args: { dev: s.hostname, net: key } });
      for (const f of fixed) {
        if (inSameNet(net, f.ip) && f.ip >= dynStart && f.ip <= dynEnd) {
          issues.push({ level: "warn", code: "dhcpStaticInPool", args: { ip: intToIp(f.ip), owner: f.owner, net: key } });
        }
      }
      pools.push({
        serverId: s.id,
        key,
        net,
        gateway,
        dns: p.dns?.trim() || undefined,
        lease: p.lease && p.lease > 0 ? Math.floor(p.lease) : undefined,
        excludeFirst: exF,
        excludeLast: exL,
        excluded,
        dynStart,
        dynEnd,
        count,
      });

      // Relay: every gateway of this network that is not the server itself (or on its own network)
      // forwards DHCP broadcasts to the server.
      const sIfaces = ifaces.filter((i) => i.deviceId === s.id);
      for (const g of inNet) {
        const local = g.deviceId === s.id || (sCidr !== null && inSameNet(net, sCidr.ip));
        if (local) continue;
        let target: number | null = null;
        if (sCidr) target = sCidr.ip;
        else {
          const near = sIfaces.find((i) => ifaces.some((j) => j.deviceId === g.deviceId && netKey(j.cidr) === netKey(i.cidr)));
          target = (near ?? sIfaces[0])?.cidr.ip ?? null;
        }
        if (target === null) {
          issues.push({ level: "warn", code: "dhcpServerNoIp", args: { dev: s.hostname } });
          continue;
        }
        const k = `${g.deviceId}|${ifaceKey(g)}`;
        const list = relays.get(k) ?? [];
        if (!list.includes(target)) list.push(target);
        relays.set(k, list);
      }
    }
  }
  return { pools, relays, hosts };
}

/** Networks a DHCP server could serve (point-to-point links excluded), with the number of clients in each. */
export function dhcpCandidates(t: Topology) {
  const ifaces = routerIfaces(t);
  const tags = networkTags(t);
  const nets = new Map<string, { key: string; cidr: Cidr; clients: number; vlan?: number; name?: string }>();
  for (const i of ifaces) {
    if (i.cidr.prefix > 29) continue;
    const key = netKey(i.cidr);
    if (!nets.has(key)) nets.set(key, { key, cidr: i.cidr, clients: 0, ...tags.get(key) });
  }
  for (const h of t.devices) {
    if (h.kind !== "pc" && h.kind !== "server" && h.kind !== "wrouter") continue;
    const n = hostNetwork(t, ifaces, h).net;
    const e = n && nets.get(netKey(n));
    if (e) e.clients++;
  }
  return [...nets.values()].sort((a, b) => a.cidr.net - b.cidr.net);
}

/**
 * Network carried by a cable, for labelling it on the canvas (e.g. "10.0.12.0 /30").
 * Returns null when the cable carries no single network, such as a trunk with several VLANs.
 * Expects the topology already translated by `applyScheme`.
 */
export function linkNetwork(t: Topology, l: { a: string; aPort: string; b: string; bPort: string }): string | null {
  const A = getDevice(t, l.a);
  const B = getDevice(t, l.b);
  if (!A || !B) return null;
  const ends = [
    [A, l.aPort],
    [B, l.bPort],
  ] as const;
  // A trunk, or a router port with subinterfaces, carries several VLANs: no single network.
  for (const [d, port] of ends) {
    if (d.kind === "switch" && d.ports[port]?.mode === "trunk") return null;
    if (d.kind === "router" && d.ports[port]?.subifs?.length) return null;
  }
  // A link between two layer-3 ports (router port or routed switch port) is a network of its own,
  // so both ends need an address. Otherwise one side alone would draw a network that does not exist.
  const isL3End = (d: Device, port: string) =>
    d.kind === "router" || d.kind === "internet" || (isL3Switch(d) && d.ports[port]?.mode === "routed");
  if (isL3End(A, l.aPort) && isL3End(B, l.bPort) && (!portIp(A, l.aPort) || !portIp(B, l.bPort))) return null;

  const nets = new Set<string>();
  for (const [d, port] of ends) {
    const fixedOrLearned = (x: Device) => (x.useDhcp ? hostNetwork(t, routerIfaces(t), x).net : parseCidr(x.ip));
    const c: Cidr | null =
      d.kind === "pc" || d.kind === "server"
        ? fixedOrLearned(d)
        : d.kind === "wrouter"
          ? port === "Internet"
            ? fixedOrLearned(d)
            : parseCidr(d.wr?.lanIp)
          : portIp(d, port);
    if (c) nets.add(`${intToIp(c.net)} /${c.prefix}`);
  }
  // Host-to-switch cables: the host's network wins; otherwise show it only if both ends agree.
  if (nets.size !== 1) return null;
  // A switch port in a VLAN: say which one, next to the network.
  const vlans = new Set<number>();
  for (const [d, port] of ends) {
    const c = d.kind === "switch" ? d.ports[port] : undefined;
    if (c && c.mode !== "trunk" && c.mode !== "routed" && c.vlan && c.vlan !== 1) vlans.add(c.vlan);
  }
  return vlans.size === 1 ? `${[...nets][0]} (VLAN ${[...vlans][0]})` : [...nets][0];
}
