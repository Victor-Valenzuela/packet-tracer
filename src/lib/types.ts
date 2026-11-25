export type DeviceKind = "router" | "switch" | "pc" | "server" | "internet" | "ap" | "wrouter";

/** Subinterface of a router port (router-on-a-stick). `ip` is CIDR: "192.168.20.1/24". */
export interface SubIf {
  vlan: number;
  ip: string;
}

export interface PortCfg {
  /** Router: IP in CIDR notation, e.g. "10.0.12.1/30". */
  ip?: string;
  /** Router: 802.1Q subinterfaces. When present, `ip` is ignored. */
  subifs?: SubIf[];
  /**
   * Switch: layer-2 port mode. Defaults to access.
   * `routed` only ever appears in the *derived* topology built by `applyScheme`;
   * stored data uses the `routed` flag below.
   */
  mode?: "access" | "trunk" | "routed";
  /**
   * Multilayer switch: this port is a layer-3 port (`no switchport` + `ip`).
   * Used by Collapsed Core. Under Router on a Stick the port keeps its L2 `mode`.
   */
  routed?: boolean;
  /** Switch access port: VLAN id. Defaults to 1. */
  vlan?: number;
}

export interface Vlan {
  id: number;
  name: string;
}

export interface Mgmt {
  vlan: number;
  /** CIDR */
  ip: string;
  gateway?: string;
}

/** One DHCP pool: serves one network. `net` is "192.168.20.0/24" (network address and prefix). */
export interface DhcpPool {
  net: string;
  /** Overrides the gateway handed to clients. Default: the gateway interface of that network. */
  gateway?: string;
  dns?: string;
  /** Addresses left out at the start of the range (gateway, fixed devices). Default 10. */
  excludeFirst?: number;
  /** Addresses left out at the end of the range. Default 0. */
  excludeLast?: number;
  /** Lease time in days. Empty = device default. */
  lease?: number;
}

/** Wi-Fi network offered by an access point or a wireless router. */
export interface WifiCfg {
  ssid: string;
  security: "wpa2" | "open";
  passphrase?: string;
  /** 2.4 GHz channel. Empty = automatic. */
  channel?: number;
}

/** LAN side of a wireless router (the WAN side uses the host fields `ip`, `gateway` and `useDhcp`). */
export interface WirelessRouterCfg {
  /** Address of the router on its own network, CIDR ("192.168.0.1/24"). */
  lanIp: string;
  dhcp: boolean;
  /** First address handed out, counted from the network address (default 100). */
  dhcpStart?: number;
  /** Maximum number of clients (default 50). */
  maxUsers?: number;
}

/** A router that connects the network to Internet (through an `internet` node). */
export interface EdgeCfg {
  enabled: boolean;
  /** Port cabled to the Internet node. */
  wanPort?: string;
  /** Translate internal addresses with PAT (`overload`). Default true. */
  nat?: boolean;
  /** Network keys ("192.168.20.0/24") that must NOT go out through NAT. */
  natExclude?: string[];
}

export interface DhcpServer {
  enabled: boolean;
  pools: DhcpPool[];
}

export interface Device {
  id: string;
  kind: DeviceKind;
  model: string;
  hostname: string;
  x: number;
  y: number;
  ports: Record<string, PortCfg>;
  /** Switch */
  vlans?: Vlan[];
  mgmt?: Mgmt;
  /** Multilayer switch: one SVI (`interface vlan N`) per VLAN it routes. */
  svis?: SubIf[];
  /** Derived only (see `applyScheme`): a multilayer switch that is acting as a plain L2 switch. */
  routingOff?: boolean;
  /** Host (pc/server): CIDR */
  ip?: string;
  gateway?: string;
  /** Host (pc/server): takes its address from DHCP instead of a fixed `ip`. */
  useDhcp?: boolean;
  /** Router, multilayer switch or server acting as DHCP server. */
  dhcpServer?: DhcpServer;
  /** Router: connects the network to Internet. */
  edge?: EdgeCfg;
  /** Internet node: an address that answers ping (e.g. 8.8.8.8), to verify the way out. */
  testIp?: string;
  /** Internet node created by the tool when a router was marked as border router. */
  auto?: boolean;
  /** Access point or wireless router: the Wi-Fi network it offers. */
  wifi?: WifiCfg;
  /** Wireless router: its LAN and DHCP server. */
  wr?: WirelessRouterCfg;
}

export interface Link {
  id: string;
  a: string;
  aPort: string;
  /** React Flow handle ids (visual only). */
  aHandle?: string;
  b: string;
  bPort: string;
  bHandle?: string;
  /** Wi-Fi association between a client and an access point or wireless router. */
  wireless?: boolean;
}

/**
 * Where inter-VLAN routing lives.
 * - roas: routers use their 802.1Q subinterfaces; multilayer switches act as plain L2 switches.
 * - core: multilayer switches route with SVIs and routed ports; router subinterfaces are ignored.
 * - advanced: everything configured is used (previous manual behaviour).
 */
export type Scheme = "roas" | "core" | "advanced";

/** Which networks may not talk to each other. Pairs are stored as two network keys ("192.168.20.0/24"). */
export interface NetPolicy {
  enabled: boolean;
  blocked: [string, string][];
}

/** How routers learn the networks behind each other. Static is the default and what older data uses. */
export type RoutingProtocol = "static" | "rip" | "ospf";

export interface RoutingCfg {
  protocol: RoutingProtocol;
  /** Do not send routing updates out of interfaces that only have users behind them. Default true. */
  passive?: boolean;
  /** The border router tells the others about its default route. Default true. */
  originate?: boolean;
  /** OSPF process id. Default 1. */
  ospfProcess?: number;
  /** OSPF area, the same for every router. Default 0. */
  ospfArea?: number;
}

/** A network whose gateway is shared by two routers or multilayer switches (HSRP). */
export interface HsrpGroup {
  /** "192.168.20.0/24" */
  net: string;
  /** Virtual gateway address: what the hosts use as default gateway. */
  vip: string;
  /** Device that answers first (priority 110). Default: the first one that has the network. */
  active?: string;
  /** Group number. Default: the VLAN id, or the position in the list. */
  group?: number;
}

export interface Redundancy {
  hsrp: HsrpGroup[];
  /** Bundle parallel cables between two switches into one logical link. */
  etherchannel?: boolean;
  /** lacp = active, pagp = desirable, on = no negotiation. */
  channelMode?: "lacp" | "pagp" | "on";
  /** Make the HSRP active device the spanning-tree root of its VLAN. Default true. */
  stpAlign?: boolean;
  rapidPvst?: boolean;
}

export interface Topology {
  devices: Device[];
  links: Link[];
  redundancy?: Redundancy;
  routing?: RoutingCfg;
  policy?: NetPolicy;
  /** Missing in data saved by older versions, which behave like `advanced`. */
  scheme?: Scheme;
}

export interface Settings {
  domain: string;
  username: string;
  password: string;
  enableSecret: string;
  banner: string;
  portSecurity: boolean;
  maxMac: number;
  bpduguard: boolean;
  shutdownUnused: boolean;
  /** Administration hardening. Everything here is off by default. */
  execTimeout: boolean;
  execTimeoutMin: number;
  sshAcl: boolean;
  /** Only this network may open SSH sessions ("192.168.10.0/24"). */
  sshNet: string;
  sshHardening: boolean;
  loginBlock: boolean;
  noCdp: boolean;
  noHttp: boolean;
  /**
   * Where the commands will be typed. Packet Tracer only gets commands the simulator accepts;
   * a real device also gets the ones that Packet Tracer lacks, and stricter values (RSA key size).
   */
  target: "pt" | "real";
  /** Layer-2 protections of the switches. Everything here is off by default. */
  nativeVlan: boolean;
  nativeVlanId: number;
  trunkAllowed: boolean;
  nonegotiate: boolean;
  dhcpSnooping: boolean;
  dai: boolean;
  /** Real devices only: Packet Tracer has no storm control. */
  stormControl: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  domain: "lab.test",
  username: "cisco",
  password: "cisco",
  enableSecret: "cisco",
  banner: "# AUTHORIZED ACCESS ONLY #",
  portSecurity: true,
  maxMac: 2,
  bpduguard: true,
  shutdownUnused: true,
  execTimeout: false,
  execTimeoutMin: 5,
  sshAcl: false,
  sshNet: "",
  sshHardening: false,
  loginBlock: false,
  noCdp: false,
  noHttp: false,
  target: "pt",
  nativeVlan: false,
  nativeVlanId: 999,
  trunkAllowed: false,
  nonegotiate: false,
  dhcpSnooping: false,
  dai: false,
  stormControl: false,
};

export interface Line {
  text: string;
  why?: string;
  indent?: number;
  /** Rendered as a grey comment line instead of a command. */
  note?: boolean;
}

export interface Block {
  id: string;
  title: string;
  lines: Line[];
}

export interface DeviceGuide {
  deviceId: string;
  hostname: string;
  kind: DeviceKind;
  model: string;
  blocks: Block[];
}

export interface Issue {
  level: "error" | "warn";
  code: string;
  args: Record<string, string | number>;
}
