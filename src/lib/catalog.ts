import type { DeviceKind } from "./types";

export interface ModelDef {
  id: string;
  kind: DeviceKind;
  label: string;
  ports: string[];
  /** Multilayer switch: can route between VLANs (`ip routing`). */
  layer3?: boolean;
  /** Needs `switchport trunk encapsulation dot1q` before `mode trunk` (3560). The 3650 does not accept it. */
  trunkEncap?: boolean;
  /** Prefix of the default hostname. Default: the one of its kind. */
  prefix?: string;
}

const range = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

/**
 * Port catalog. Add a model by adding an entry here.
 * Port names use the short form (Fa / Gig); `ifaceFull` expands them for CLI output.
 */
export const MODELS: ModelDef[] = [
  { id: "2911", kind: "router", label: "Router 2911", ports: ["Gig0/0", "Gig0/1", "Gig0/2"] },
  { id: "1941", kind: "router", label: "Router 1941", ports: ["Gig0/0", "Gig0/1"] },
  { id: "2811", kind: "router", label: "Router 2811", ports: ["Fa0/0", "Fa0/1"] },
  {
    id: "2960-24TT",
    kind: "switch",
    label: "Switch L2 2960",
    ports: [...range("Fa0/", 1, 24), "Gig0/1", "Gig0/2"],
  },
  {
    id: "3560-24PS",
    kind: "switch",
    label: "Switch L3 3560",
    ports: [...range("Fa0/", 1, 24), "Gig0/1", "Gig0/2"],
    layer3: true,
    trunkEncap: true,
  },
  {
    id: "3650-24PS",
    kind: "switch",
    label: "Switch L3 3650",
    ports: [...range("Gig1/0/", 1, 24), ...range("Gig1/1/", 1, 4)],
    layer3: true,
  },
  { id: "Internet", kind: "internet", label: "Internet (ISP)", ports: ["Gig0/0", "Gig0/1", "Gig0/2", "Gig0/3"] },
  { id: "AccessPoint-PT", kind: "ap", label: "Access Point", ports: ["Eth0", "Wl0"] },
  { id: "WRT300N", kind: "wrouter", label: "Router Wi-Fi", ports: ["Internet", "Eth1", "Eth2", "Eth3", "Eth4", "Wl0"] },
  { id: "PC-PT", kind: "pc", label: "PC", ports: ["Fa0"] },
  { id: "Laptop-PT", kind: "pc", label: "Laptop", ports: ["Fa0", "Wl0"], prefix: "LT" },
  { id: "Smartphone-PT", kind: "pc", label: "Smartphone", ports: ["Wl0"], prefix: "PH" },
  { id: "Server-PT", kind: "server", label: "Server", ports: ["Fa0"] },
];

export const modelById = (id: string): ModelDef =>
  MODELS.find((m) => m.id === id) ?? MODELS[0];

/** Multilayer switch (3560). */
export const isL3Switch = (d: { kind: DeviceKind; model: string; routingOff?: boolean }): boolean =>
  d.kind === "switch" && !!modelById(d.model).layer3 && !d.routingOff;

/** Anything that routes: routers and multilayer switches. */
export const isL3Device = (d: { kind: DeviceKind; model: string }): boolean =>
  d.kind === "router" || isL3Switch(d);

export const defaultModel = (kind: DeviceKind): ModelDef =>
  MODELS.find((m) => m.kind === kind) ?? MODELS[0];

/** "Gig0/1" -> "GigabitEthernet0/1" */
export function ifaceFull(port: string): string {
  if (port.startsWith("Gig")) return "GigabitEthernet" + port.slice(3);
  if (port.startsWith("Fa")) return "FastEthernet" + port.slice(2);
  return port;
}

export const hostPrefix: Record<DeviceKind, string> = {
  router: "R",
  switch: "SW",
  pc: "PC",
  server: "SRV",
  internet: "ISP",
  ap: "AP",
  wrouter: "WR",
};

/** Ports that are a radio, not a cable. */
export const isRadioPort = (port: string) => port.startsWith("Wl");

/** Can join a Wi-Fi network. */
export const hasWifi = (d: { model: string }) => modelById(d.model).ports.some(isRadioPort);

/** Offers a Wi-Fi network: access point or wireless router. */
export const isRadio = (d: { kind: DeviceKind }) => d.kind === "ap" || d.kind === "wrouter";
