import type { Scheme, Topology } from "./types";

/**
 * Three routers with a switch behind R2. The same cables work for both schemes:
 * - Router on a Stick: R2 Gig0/2 has subinterfaces and the switch port is a trunk.
 * - Collapsed Core: the switch routes the VLANs with SVIs and its Gig0/1 is a routed /30 link to R2.
 * This version uses a multilayer 3560, which supports both. See `exampleFor`.
 */
const BASE: Topology = {
  scheme: "roas",
  devices: [
    {
      id: "r1", kind: "router", model: "2911", hostname: "R1-HH", x: 60, y: 40,
      ports: {
        "Gig0/0": { ip: "10.0.12.1/30" },
        "Gig0/1": { ip: "192.168.10.1/24" },
      },
    },
    {
      id: "r2", kind: "router", model: "2911", hostname: "R2", x: 360, y: 20,
      ports: {
        "Gig0/0": { ip: "10.0.12.2/30" },
        "Gig0/1": { ip: "10.0.23.1/30" },
        "Gig0/2": {
          ip: "10.0.20.1/30",
          subifs: [
            { vlan: 20, ip: "192.168.20.1/24" },
            { vlan: 40, ip: "192.168.40.1/24" },
          ],
        },
      },
    },
    {
      id: "r3", kind: "router", model: "2911", hostname: "R3-BER", x: 660, y: 40,
      ports: {
        "Gig0/0": { ip: "10.0.23.2/30" },
        "Gig0/1": { ip: "192.168.30.1/24" },
      },
    },
    {
      id: "sw1", kind: "switch", model: "3560-24PS", hostname: "SW-BBF", x: 360, y: 200,
      vlans: [
        { id: 20, name: "PCs" },
        { id: 40, name: "Servers" },
      ],
      svis: [
        { vlan: 20, ip: "192.168.20.1/24" },
        { vlan: 40, ip: "192.168.40.1/24" },
      ],
      ports: {
        "Gig0/1": { mode: "trunk", routed: true, ip: "10.0.20.2/30" },
        "Fa0/1": { mode: "access", vlan: 20 },
        "Fa0/2": { mode: "access", vlan: 40 },
      },
    },
    { id: "pc1", kind: "pc", model: "PC-PT", hostname: "PC-HH", x: 80, y: 260, ports: {}, ip: "192.168.10.10/24", gateway: "192.168.10.1" },
    { id: "pc2", kind: "pc", model: "PC-PT", hostname: "PC2", x: 200, y: 400, ports: {}, ip: "192.168.20.10/24", gateway: "192.168.20.1" },
    { id: "srv1", kind: "server", model: "Server-PT", hostname: "Server", x: 480, y: 400, ports: {}, ip: "192.168.40.10/24", gateway: "192.168.40.1" },
    { id: "pc3", kind: "pc", model: "PC-PT", hostname: "PC-BER", x: 680, y: 260, ports: {}, ip: "192.168.30.10/24", gateway: "192.168.30.1" },
  ],
  links: [
    { id: "l1", a: "r1", aPort: "Gig0/0", aHandle: "r", b: "r2", bPort: "Gig0/0", bHandle: "l" },
    { id: "l2", a: "r2", aPort: "Gig0/1", aHandle: "r", b: "r3", bPort: "Gig0/0", bHandle: "l" },
    { id: "l3", a: "r1", aPort: "Gig0/1", aHandle: "b", b: "pc1", bPort: "Fa0", bHandle: "t" },
    { id: "l4", a: "r2", aPort: "Gig0/2", aHandle: "b", b: "sw1", bPort: "Gig0/1", bHandle: "t" },
    { id: "l5", a: "r3", aPort: "Gig0/1", aHandle: "b", b: "pc3", bPort: "Fa0", bHandle: "t" },
    { id: "l6", a: "sw1", aPort: "Fa0/1", aHandle: "b", b: "pc2", bPort: "Fa0", bHandle: "t" },
    { id: "l7", a: "sw1", aPort: "Fa0/2", aHandle: "b", b: "srv1", bPort: "Fa0", bHandle: "t" },
  ],
};

/**
 * Example for the chosen scheme. Router on a Stick only needs a layer-2 switch (2960);
 * Collapsed Core needs the multilayer one (3560), which also carries the SVI data.
 */
export function exampleFor(scheme: Scheme): Topology {
  const t: Topology = structuredClone(BASE);
  t.scheme = scheme;
  if (scheme === "roas") {
    const sw = t.devices.find((d) => d.id === "sw1")!;
    sw.model = "2960-24TT";
    delete sw.svis;
    sw.ports["Gig0/1"] = { mode: "trunk" };
  }
  return t;
}

export const EXAMPLE: Topology = exampleFor("roas");

/**
 * Two multilayer switches that back each other up: the gateway of each VLAN is shared (HSRP), the two
 * parallel cables between them are one EtherChannel, and the access switch has an uplink to each core.
 */
export function exampleRedundant(): Topology {
  const vlans = [
    { id: 20, name: "PCs" },
    { id: 40, name: "Servers" },
  ];
  return {
    scheme: "core",
    redundancy: {
      hsrp: [
        { net: "192.168.20.0/24", vip: "192.168.20.1", active: "core1" },
        { net: "192.168.40.0/24", vip: "192.168.40.1", active: "core2" },
      ],
      etherchannel: true,
      channelMode: "lacp",
      stpAlign: true,
      rapidPvst: true,
    },
    devices: [
      {
        id: "core1", kind: "switch", model: "3560-24PS", hostname: "CORE1", x: 120, y: 60,
        vlans,
        svis: [
          { vlan: 20, ip: "192.168.20.2/24" },
          { vlan: 40, ip: "192.168.40.2/24" },
        ],
        ports: { "Fa0/1": { mode: "trunk" }, "Fa0/23": { mode: "trunk" }, "Fa0/24": { mode: "trunk" } },
      },
      {
        id: "core2", kind: "switch", model: "3560-24PS", hostname: "CORE2", x: 520, y: 60,
        vlans,
        svis: [
          { vlan: 20, ip: "192.168.20.3/24" },
          { vlan: 40, ip: "192.168.40.3/24" },
        ],
        ports: { "Fa0/1": { mode: "trunk" }, "Fa0/23": { mode: "trunk" }, "Fa0/24": { mode: "trunk" } },
      },
      {
        id: "acc", kind: "switch", model: "2960-24TT", hostname: "SW-ACC", x: 320, y: 260,
        vlans,
        ports: {
          "Gig0/1": { mode: "trunk" },
          "Gig0/2": { mode: "trunk" },
          "Fa0/1": { mode: "access", vlan: 20 },
          "Fa0/2": { mode: "access", vlan: 40 },
        },
      },
      { id: "pc1", kind: "pc", model: "PC-PT", hostname: "PC1", x: 190, y: 430, ports: {}, ip: "192.168.20.10/24", gateway: "192.168.20.1" },
      { id: "srv", kind: "server", model: "Server-PT", hostname: "Server", x: 460, y: 430, ports: {}, ip: "192.168.40.10/24", gateway: "192.168.40.1" },
    ],
    links: [
      { id: "l1", a: "core1", aPort: "Fa0/23", aHandle: "r", b: "core2", bPort: "Fa0/23", bHandle: "l" },
      { id: "l2", a: "core1", aPort: "Fa0/24", aHandle: "t", b: "core2", bPort: "Fa0/24", bHandle: "t" },
      { id: "l3", a: "core1", aPort: "Fa0/1", aHandle: "b", b: "acc", bPort: "Gig0/1", bHandle: "t" },
      { id: "l4", a: "core2", aPort: "Fa0/1", aHandle: "b", b: "acc", bPort: "Gig0/2", bHandle: "t" },
      { id: "l5", a: "acc", aPort: "Fa0/1", aHandle: "b", b: "pc1", bPort: "Fa0", bHandle: "t" },
      { id: "l6", a: "acc", aPort: "Fa0/2", aHandle: "b", b: "srv", bPort: "Fa0", bHandle: "t" },
    ],
  };
}
