import { hasWifi, hostPrefix, isRadio, isRadioPort, modelById } from "./catalog";
import type { Device, DeviceKind, Link, PortCfg, Topology } from "./types";

export const emptyTopology = (): Topology => ({ devices: [], links: [], scheme: "roas" });

const usedPorts = (t: Topology, deviceId: string): string[] => {
  const out: string[] = [];
  for (const l of t.links) {
    if (l.a === deviceId) out.push(l.aPort);
    if (l.b === deviceId) out.push(l.bPort);
  }
  return out;
};

export const freePort = (t: Topology, d: Device): string | null => {
  const used = usedPorts(t, d.id);
  return modelById(d.model).ports.find((p) => !isRadioPort(p) && !used.includes(p)) ?? null;
};

/** Free wired port for a new cable. A wireless router keeps "Internet" for upstream gear and LAN ports for hosts. */
function pickWiredPort(t: Topology, d: Device, other: Device): string | null {
  const used = usedPorts(t, d.id);
  const ports = modelById(d.model).ports.filter((p) => !isRadioPort(p) && !used.includes(p));
  if (d.kind === "wrouter") {
    const lan = ports.filter((p) => p !== "Internet");
    if (other.kind === "pc" || other.kind === "server") return lan[0] ?? null;
    return ports.includes("Internet") ? "Internet" : (lan[0] ?? null);
  }
  return ports[0] ?? null;
}

function nextHostname(t: Topology, kind: DeviceKind, prefixOverride?: string): string {
  const prefix = prefixOverride ?? hostPrefix[kind];
  const names = new Set(t.devices.map((d) => d.hostname));
  let n = 1;
  while (names.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

const nextId = (t: Topology, base: string) => {
  const ids = new Set([...t.devices.map((d) => d.id), ...t.links.map((l) => l.id)]);
  let n = 1;
  while (ids.has(`${base}${n}`)) n++;
  return `${base}${n}`;
};

export function addDevice(t: Topology, modelId: string, x: number, y: number): { topo: Topology; id: string } {
  const m = modelById(modelId);
  const id = nextId(t, "d");
  const dev: Device = {
    id,
    kind: m.kind,
    model: m.id,
    hostname: nextHostname(t, m.kind, m.prefix),
    x,
    y,
    ports: {},
    ...(m.kind === "switch" ? { vlans: [] } : {}),
    ...(m.layer3 ? { svis: [] } : {}),
    ...(m.kind === "pc" || m.kind === "server" || m.kind === "wrouter" ? { ip: "", gateway: "" } : {}),
    ...(m.kind === "ap" || m.kind === "wrouter" ? { wifi: { ssid: "", security: "wpa2" as const, passphrase: "" } } : {}),
    ...(m.kind === "wrouter" ? { wr: { lanIp: "", dhcp: true } } : {}),
  };
  return { topo: { ...t, devices: [...t.devices, dev] }, id };
}

export function updateDevice(t: Topology, id: string, patch: Partial<Device>): Topology {
  return { ...t, devices: t.devices.map((d) => (d.id === id ? { ...d, ...patch } : d)) };
}

export function updatePort(t: Topology, id: string, port: string, patch: Partial<PortCfg>): Topology {
  return {
    ...t,
    devices: t.devices.map((d) =>
      d.id === id ? { ...d, ports: { ...d.ports, [port]: { ...d.ports[port], ...patch } } } : d,
    ),
  };
}

/** Changes the model while keeping the configuration of ports that still exist. */
export function changeModel(t: Topology, id: string, modelId: string): Topology {
  const m = modelById(modelId);
  const d = t.devices.find((x) => x.id === id);
  if (!d || m.kind !== d.kind) return t;
  const keep = new Set(m.ports);
  const drop = new Set<string>();
  const links = t.links.filter((l) => {
    if (l.a === id && !keep.has(l.aPort)) return (drop.add(`${l.b}|${l.bPort}`), false);
    if (l.b === id && !keep.has(l.bPort)) return (drop.add(`${l.a}|${l.aPort}`), false);
    return true;
  });
  const devices = t.devices.map((x) => {
    if (x.id === id) {
      let ports: Device["ports"] = Object.fromEntries(Object.entries(x.ports).filter(([p]) => keep.has(p)));
      const next: Device = { ...x, model: modelId, ports };
      if (m.layer3) {
        next.svis = x.svis ?? [];
      } else {
        // A layer-2 model cannot route: drop SVIs and turn routed ports into access ports.
        delete next.svis;
        ports = Object.fromEntries(
          Object.entries(ports).map(([p, c]) => {
            const { routed: _routed, ...rest } = c;
            return [p, rest];
          }),
        );
        next.ports = ports;
      }
      return next;
    }
    const ports = { ...x.ports };
    for (const key of drop) {
      const [did, p] = key.split("|");
      if (did === x.id) delete ports[p];
    }
    return { ...x, ports };
  });
  return { ...t, devices, links };
}

function clearPort(devices: Device[], deviceId: string, port: string): Device[] {
  return devices.map((d) => {
    if (d.id !== deviceId || !(port in d.ports)) return d;
    const ports = { ...d.ports };
    delete ports[port];
    return { ...d, ports };
  });
}

export function removeLink(t: Topology, linkId: string): Topology {
  const l = t.links.find((x) => x.id === linkId);
  if (!l) return t;
  let devices = clearPort(t.devices, l.a, l.aPort);
  devices = clearPort(devices, l.b, l.bPort);
  return { ...t, devices, links: t.links.filter((x) => x.id !== linkId) };
}

export function removeDevice(t: Topology, id: string): Topology {
  let cur = t;
  for (const l of t.links.filter((x) => x.a === id || x.b === id)) cur = removeLink(cur, l.id);
  return { ...cur, devices: cur.devices.filter((d) => d.id !== id) };
}

/**
 * Turns a router into the one that leaves for Internet. Reuses an Internet node already cabled to
 * it; otherwise adds one next to the router and cables it to a free port.
 */
export function enableEdge(t: Topology, routerId: string): Topology {
  const r = t.devices.find((d) => d.id === routerId);
  if (!r || r.kind !== "router") return t;
  const cfg = (wanPort: string) => ({ nat: true, ...r.edge, enabled: true, wanPort });
  for (const l of t.links) {
    const other = l.a === routerId ? l.b : l.b === routerId ? l.a : null;
    if (other && t.devices.find((d) => d.id === other)?.kind === "internet") {
      return updateDevice(t, routerId, { edge: cfg(l.a === routerId ? l.aPort : l.bPort) });
    }
  }
  const added = addDevice(t, "Internet", r.x + 200, r.y - 150);
  added.topo = updateDevice(added.topo, added.id, { auto: true });
  const c = connect(added.topo, routerId, "r", added.id, "l");
  if (!c || !c.ok) return t;
  const link = c.topo.links.find((l) => l.id === c.linkId)!;
  return updateDevice(c.topo, routerId, { edge: cfg(link.a === routerId ? link.aPort : link.bPort) });
}

/**
 * Stops using a router as border router. An Internet node that the tool created for it is removed
 * with its cable; one the user added by hand stays.
 */
export function disableEdge(t: Topology, routerId: string): Topology {
  const r = t.devices.find((d) => d.id === routerId);
  if (!r) return t;
  let cur = updateDevice(t, routerId, { edge: { ...r.edge, enabled: false, wanPort: undefined } });
  const nodes = new Set<string>();
  for (const l of cur.links) {
    const other = l.a === routerId ? l.b : l.b === routerId ? l.a : null;
    const node = other ? cur.devices.find((d) => d.id === other) : undefined;
    if (node?.kind === "internet" && node.auto) nodes.add(node.id);
  }
  for (const id of nodes) {
    for (const l of cur.links.filter((x) => (x.a === routerId && x.b === id) || (x.b === routerId && x.a === id))) {
      cur = removeLink(cur, l.id);
    }
    // Shared with another border router: keep the node.
    if (!cur.links.some((l) => l.a === id || l.b === id)) cur = removeDevice(cur, id);
  }
  return cur;
}

export type ConnectResult =
  | { ok: true; topo: Topology; linkId: string }
  | { ok: false; dev: string; reason?: "busy" };

/** Cables two devices using the first free port on each side. */
export function connect(
  t: Topology,
  a: string,
  aHandle: string | undefined,
  b: string,
  bHandle: string | undefined,
): ConnectResult | null {
  if (a === b) return null;
  const A = t.devices.find((d) => d.id === a);
  const B = t.devices.find((d) => d.id === b);
  if (!A || !B) return null;
  // A device that can join Wi-Fi next to an access point or wireless router associates wirelessly.
  const [radio, client] = isRadio(A) && B.kind === "pc" && hasWifi(B) ? [A, B] : isRadio(B) && A.kind === "pc" && hasWifi(A) ? [B, A] : [null, null];
  if (radio && client) {
    const wl = modelById(client.model).ports.find(isRadioPort)!;
    if (usedPorts(t, client.id).includes(wl)) return { ok: false, dev: client.hostname, reason: "busy" };
    const rp = modelById(radio.model).ports.find(isRadioPort)!;
    const id = nextId(t, "l");
    const aIsRadio = radio.id === A.id;
    const link: Link = aIsRadio
      ? { id, a, aPort: rp, aHandle, b, bPort: wl, bHandle, wireless: true }
      : { id, a, aPort: wl, aHandle, b, bPort: rp, bHandle, wireless: true };
    return { ok: true, topo: { ...t, links: [...t.links, link] }, linkId: id };
  }
  const ap = pickWiredPort(t, A, B);
  if (!ap) return { ok: false, dev: A.hostname };
  const bp = pickWiredPort(t, B, A);
  if (!bp) return { ok: false, dev: B.hostname };
  const id = nextId(t, "l");
  const link: Link = { id, a, aPort: ap, aHandle, b, bPort: bp, bHandle };
  let topo: Topology = { ...t, links: [...t.links, link] };
  // Sensible defaults: switch ports start as access, VLAN 1.
  for (const [dev, port] of [[A, ap], [B, bp]] as const) {
    if (dev.kind === "switch") topo = updatePort(topo, dev.id, port, { mode: "access" });
  }
  return { ok: true, topo, linkId: id };
}

/** Moves a cable end to another port of the same device, carrying its configuration. */
export function changeLinkPort(t: Topology, linkId: string, end: "a" | "b", newPort: string): Topology {
  const l = t.links.find((x) => x.id === linkId);
  if (!l) return t;
  const dev = end === "a" ? l.a : l.b;
  const old = end === "a" ? l.aPort : l.bPort;
  if (old === newPort || usedPorts(t, dev).includes(newPort)) return t;
  const devices = t.devices.map((d) => {
    if (d.id !== dev) return d;
    const ports = { ...d.ports };
    if (old in ports) {
      ports[newPort] = ports[old];
      delete ports[old];
    }
    return { ...d, ports };
  });
  const links = t.links.map((x) =>
    x.id === linkId ? (end === "a" ? { ...x, aPort: newPort } : { ...x, bPort: newPort }) : x,
  );
  return { ...t, devices, links };
}

export function isTopology(x: unknown): x is Topology {
  if (!x || typeof x !== "object") return false;
  const t = x as Topology;
  if (!Array.isArray(t.devices) || !Array.isArray(t.links)) return false;
  if (t.scheme !== undefined && !["roas", "core", "advanced"].includes(t.scheme)) return false;
  if (t.redundancy !== undefined && !Array.isArray(t.redundancy.hsrp)) return false;
  if (t.routing !== undefined && !["static", "rip", "ospf"].includes(t.routing.protocol)) return false;
  if (t.policy !== undefined && (typeof t.policy.enabled !== "boolean" || !Array.isArray(t.policy.blocked))) return false;
  const ids = new Set<string>();
  for (const d of t.devices) {
    if (typeof d?.id !== "string" || typeof d.hostname !== "string" || typeof d.model !== "string") return false;
    if (!["router", "switch", "pc", "server", "internet", "ap", "wrouter"].includes(d.kind)) return false;
    if (typeof d.x !== "number" || typeof d.y !== "number" || typeof d.ports !== "object" || !d.ports) return false;
    ids.add(d.id);
  }
  return t.links.every(
    (l) =>
      typeof l?.id === "string" &&
      ids.has(l.a) &&
      ids.has(l.b) &&
      typeof l.aPort === "string" &&
      typeof l.bPort === "string",
  );
}
