import { modelById } from "./catalog";
import type { Device, PortCfg, Scheme, Topology } from "./types";

export const schemeOf = (t: Topology): Scheme => t.scheme ?? "advanced";

const mapPorts = (ports: Device["ports"], f: (c: PortCfg) => PortCfg): Device["ports"] =>
  Object.fromEntries(Object.entries(ports).map(([p, c]) => [p, f(c)]));

/**
 * Builds the topology that analysis and command generation actually use.
 * The stored topology keeps the data of every scheme (router subinterfaces AND
 * switch SVIs / routed ports); this picks the ones that apply to the chosen scheme.
 */
export function applyScheme(t: Topology): Topology {
  const scheme = schemeOf(t);
  const devices = t.devices.map((d): Device => {
    if (d.kind === "router") {
      if (scheme === "roas") {
        // A port with subinterfaces is a trunk toward a switch: its plain IP is not used.
        return {
          ...d,
          ports: mapPorts(d.ports, (c) => {
            if (!c.subifs?.length) return c;
            const { ip: _ip, ...rest } = c;
            return rest;
          }),
        };
      }
      if (scheme === "core") {
        return {
          ...d,
          ports: mapPorts(d.ports, (c) => {
            const { subifs: _subifs, ...rest } = c;
            return rest;
          }),
        };
      }
      return d;
    }
    if (d.kind === "switch" && modelById(d.model).layer3) {
      if (scheme === "roas") {
        // Multilayer switch behaving as a plain L2 switch.
        const { svis: _svis, ...rest } = d;
        return {
          ...rest,
          routingOff: true,
          ports: mapPorts(d.ports, (c) => {
            const { routed: _routed, ...r } = c;
            return r;
          }),
        };
      }
      return {
        ...d,
        ports: mapPorts(d.ports, (c) => (c.routed ? { ...c, mode: "routed" as const } : c)),
      };
    }
    return d;
  });
  return { ...t, devices };
}

/**
 * Upgrades data saved by earlier versions, where a routed port was `mode: "routed"`.
 */
export function normalize(t: Topology): Topology {
  return {
    ...t,
    devices: t.devices.map((d) => ({
      ...d,
      ports: mapPorts(d.ports, (c) => {
        if (c.mode !== "routed") return c;
        return { ...c, mode: "access" as const, routed: true };
      }),
    })),
  };
}
