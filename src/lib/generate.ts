import type { Dict } from "../i18n";
import { ifaceFull, isL3Device, isL3Switch, isRadioPort, modelById } from "./catalog";
import { analyze, bundlePorts, classfulNet, connectedPorts, getDevice, ifaceKey, peerOf, type Analysis, type DhcpPoolPlan, type RouterIface } from "./analyze";
import { ipToInt, maskStr, parseCidr, intToIp, wildcardStr } from "./net";
import type { Block, Device, DeviceGuide, Line, Settings, Topology } from "./types";

const L = (text: string, why?: string, indent = 0): Line => ({ text, why, indent });
const NOTE = (text: string, indent = 0): Line => ({ text, indent, note: true });

function basicBlock(d: Device, s: Settings, t: Dict): Block {
  const banner = s.banner.replace(/\$/g, "");
  const timeout = Math.min(35791, Math.max(1, Math.floor(s.execTimeoutMin) || 5));
  const sshNet = s.sshAcl ? parseCidr(s.sshNet) : null;
  const lines: Line[] = [
    L("enable"),
    L("configure terminal"),
    L(`hostname ${d.hostname}`, t.why.hostname),
    L(`ip domain-name ${s.domain}`, t.why.domain),
    L("no ip domain-lookup", t.why.nolookup),
    L(`username ${s.username} privilege 15 secret ${s.password}`, t.why.user),
    L(`enable secret ${s.enableSecret}`, t.why.enable),
    L("service password-encryption", t.why.pwenc),
    L(`banner motd $ ${banner} $`, t.why.banner),
  ];
  if (s.noCdp) lines.push(L("no cdp run", t.why.noCdp));
  if (s.noHttp) lines.push(L("no ip http server", t.why.noHttp));
  if (sshNet) {
    lines.push(L("ip access-list standard VTY_ACCESS", t.why.vtyAcl));
    lines.push(L(`permit ${intToIp(sshNet.net)} ${wildcardStr(sshNet.prefix)}`, undefined, 1));
    lines.push(L("exit", undefined, 1));
  }
  lines.push(L("line console 0", t.why.console));
  lines.push(L("login local", undefined, 1));
  lines.push(L("logging synchronous", undefined, 1));
  if (s.execTimeout) lines.push(L(`exec-timeout ${timeout} 0`, t.why.execTimeout, 1));
  lines.push(L("exit", undefined, 1));
  lines.push(L("line vty 0 15", t.why.vty));
  lines.push(L("login local", undefined, 1));
  lines.push(L("transport input ssh", undefined, 1));
  if (sshNet) lines.push(L("access-class VTY_ACCESS in", t.why.accessClass, 1));
  if (s.execTimeout) lines.push(L(`exec-timeout ${timeout} 0`, undefined, 1));
  lines.push(L("exit", undefined, 1));
  lines.push(L(`crypto key generate rsa modulus ${s.target === "real" ? 2048 : 1024}`, t.why.rsa));
  lines.push(L("ip ssh version 2", t.why.ssh));
  if (s.sshHardening) {
    lines.push(L("ip ssh time-out 60", t.why.sshHard));
    lines.push(L("ip ssh authentication-retries 3"));
  }
  if (s.loginBlock) lines.push(L("login block-for 120 attempts 3 within 60", t.why.loginBlock));
  return { id: "basic", title: t.blocks.basic, lines };
}

/** HSRP lines of one interface: the shared gateway address, who answers first, and taking over again afterwards. */
const hsrpLines = (an: Analysis, devId: string, key: string, t: Dict): Line[] => {
  const h = an.hsrp.get(`${devId}|${key}`);
  if (!h) return [];
  return [
    L(`standby ${h.group} ip ${intToIp(h.vip)}`, t.why.hsrpIp, 1),
    ...(h.priority !== 100 ? [L(`standby ${h.group} priority ${h.priority}`, t.why.hsrpPrio, 1)] : []),
    L(`standby ${h.group} preempt`, t.why.hsrpPreempt, 1),
  ];
};

/** Interface name as the routing commands want it (`passive-interface`). */
const routedIfaceName = (i: RouterIface) =>
  i.port.startsWith("Vlan") ? `Vlan${i.vlan}` : i.vlan !== undefined ? `${ifaceFull(i.port)}.${i.vlan}` : ifaceFull(i.port);

/** RIPv2 or OSPF on a router or multilayer switch. */
function dynBlock(d: Device, an: Analysis, t: Dict): Block | null {
  const p = an.dyn.get(d.id);
  if (!p) return null;
  const lines: Line[] = [];
  const passive = p.passive.map(routedIfaceName).filter((v, i, a) => a.indexOf(v) === i);
  if (p.protocol === "rip") {
    lines.push(L("router rip", t.why.ripStart));
    lines.push(L("version 2", t.why.ripVersion, 1));
    lines.push(L("no auto-summary", t.why.ripNoSummary, 1));
    const classful = [...new Set(p.networks.map((n) => classfulNet(n.ip)))];
    classful.forEach((n, i) => lines.push(L(`network ${n}`, i === 0 ? t.why.ripNetwork : undefined, 1)));
  } else {
    lines.push(L(`router ospf ${p.process}`, t.why.ospfStart));
    p.networks.forEach((n, i) =>
      lines.push(L(`network ${intToIp(n.net)} ${wildcardStr(n.prefix)} area ${p.area}`, i === 0 ? t.why.ospfNetwork : undefined, 1)),
    );
  }
  passive.forEach((n, i) => lines.push(L(`passive-interface ${n}`, i === 0 ? t.why.passive : undefined, 1)));
  if (p.originate) lines.push(L("default-information originate", t.why.originate, 1));
  lines.push(L("exit", undefined, 1));
  return { id: "dynamic", title: p.protocol === "rip" ? t.blocks.rip : t.blocks.ospf, lines };
}

/** `show standby brief` on a device that takes part in an HSRP group. */
const standbyVerify = (d: Device, an: Analysis, t: Dict): Line[] =>
  an.hsrpGroups.some((g) => g.activeId === d.id || g.standbyIds.includes(d.id)) ? [L("show standby brief", t.verify.cmdStandby)] : [];

/** Commands that check the routing protocol. */
const dynVerify = (d: Device, an: Analysis, t: Dict): Line[] => {
  const p = an.dyn.get(d.id);
  if (!p) return [];
  return [
    L("show ip protocols", t.verify.cmdProtocols),
    p.protocol === "ospf" ? L("show ip ospf neighbor", t.verify.cmdOspfNbr) : L("show ip rip database", t.verify.cmdRipDb),
  ];
};

/** VLANs in use anywhere in the topology: defined on a switch, an SVI, a router subinterface or management. */
export function usedVlans(topo: Topology): number[] {
  const out = new Set<number>();
  for (const d of topo.devices) {
    for (const v of d.vlans ?? []) out.add(v.id);
    for (const v of d.svis ?? []) out.add(v.vlan);
    for (const c of Object.values(d.ports)) for (const sub of c.subifs ?? []) out.add(sub.vlan);
    if (d.mgmt) out.add(d.mgmt.vlan);
  }
  out.delete(1);
  return [...out].sort((a, b) => a - b);
}

/** ACLs that keep the blocked networks apart, applied inbound on the gateway interface of each network. */
function policyBlock(d: Device, an: Analysis, t: Dict): Block | null {
  const plans = an.acls.get(d.id);
  if (!plans?.length) return null;
  const lines: Line[] = [];
  plans.forEach((p, i) => {
    lines.push(L(`ip access-list extended ${p.name}`, i === 0 ? t.why.polAcl : undefined));
    p.rules.forEach((r, j) => {
      lines.push(
        L(
          `deny ip ${intToIp(r.src.net)} ${wildcardStr(r.src.prefix)} ${intToIp(r.dst.net)} ${wildcardStr(r.dst.prefix)}`,
          i === 0 && j === 0 ? t.why.polDeny : undefined,
          1,
        ),
      );
    });
    lines.push(L("permit ip any any", i === 0 ? t.why.polPermit : undefined, 1));
    lines.push(L("exit", undefined, 1));
  });
  plans.forEach((p, i) => {
    const { port, vlan } = p.iface;
    const name = port.startsWith("Vlan") ? `vlan ${vlan}` : vlan !== undefined ? `${ifaceFull(port)}.${vlan}` : ifaceFull(port);
    lines.push(L(`interface ${name}`, i === 0 ? t.why.polApply : undefined));
    lines.push(L(`ip access-group ${p.name} in`, undefined, 1));
    lines.push(L("exit", undefined, 1));
  });
  return { id: "policy", title: t.blocks.policy, lines };
}

/** `ip helper-address` lines for one interface, when a DHCP server lives elsewhere. */
const helperLines = (an: Analysis, devId: string, key: string, t: Dict): Line[] =>
  (an.dhcp.relays.get(`${devId}|${key}`) ?? []).map((ip, i) =>
    L(`ip helper-address ${intToIp(ip)}`, i === 0 ? t.why.helper : undefined, 1),
  );

const poolName = (p: DhcpPoolPlan) => `POOL_${intToIp(p.net.net).replace(/\./g, "_")}`;
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/** The router that stands for Internet. Needs an address on its side of each link, and return routes without NAT. */
function ispGuide(d: Device, topo: Topology, t: Dict, an: Analysis): Block[] {
  const model = modelById(d.model);
  const lines: Line[] = [L("enable"), L("configure terminal"), L(`hostname ${d.hostname}`, t.why.hostname)];
  let first = true;
  for (const port of model.ports.filter((p) => connectedPorts(topo, d.id).includes(p))) {
    const c = parseCidr(d.ports[port]?.ip);
    const dsc = desc(topo, d, port, t);
    lines.push(L(`interface ${ifaceFull(port)}`));
    if (dsc) lines.push(L(dsc, undefined, 1));
    lines.push(c ? L(`ip address ${intToIp(c.ip)} ${maskStr(c.prefix)}`, first ? t.why.ispIf : undefined, 1) : NOTE("ip address ?", 1));
    lines.push(L("no shutdown", undefined, 1));
    lines.push(L("exit", undefined, 1));
    first = false;
  }
  const test = ipToInt(d.testIp ?? "");
  if (test !== null) {
    lines.push(L("interface loopback 0", t.why.ispLoop));
    lines.push(L(`ip address ${intToIp(test)} 255.255.255.255`, undefined, 1));
    lines.push(L("exit", undefined, 1));
  }
  // Without NAT the ISP has to know how to get back to the internal networks.
  let firstRoute = true;
  for (const e of an.edges.values()) {
    if (e.ispId !== d.id || e.nat || !e.wanIp) continue;
    for (const n of e.inside) {
      lines.push(L(`ip route ${intToIp(n.net)} ${maskStr(n.prefix)} ${intToIp(e.wanIp.ip)}`, firstRoute ? t.why.ispRoutes : undefined));
      firstRoute = false;
    }
  }
  return [
    { id: "isp", title: t.blocks.isp, lines },
    {
      id: "save",
      title: t.blocks.save,
      lines: [L("end"), L("write memory", t.why.save), L("show ip interface brief", t.verify.cmdIface)],
    },
  ];
}

/** DHCP server on a router or multilayer switch (CLI). */
function dhcpCliBlock(d: Device, an: Analysis, t: Dict): Block | null {
  const pools = an.dhcp.pools.filter((p) => p.serverId === d.id);
  if (!pools.length) return null;
  const lines: Line[] = [];
  let firstEx = true;
  for (const p of pools) {
    for (const [a, b] of p.excluded) {
      lines.push(
        L(a === b ? `ip dhcp excluded-address ${intToIp(a)}` : `ip dhcp excluded-address ${intToIp(a)} ${intToIp(b)}`, firstEx ? t.why.dhcpExcl : undefined),
      );
      firstEx = false;
    }
  }
  pools.forEach((p, i) => {
    lines.push(L(`ip dhcp pool ${poolName(p)}`, i === 0 ? t.why.dhcpPool : undefined));
    lines.push(L(`network ${intToIp(p.net.net)} ${maskStr(p.net.prefix)}`, undefined, 1));
    if (p.gateway !== null) lines.push(L(`default-router ${intToIp(p.gateway)}`, i === 0 ? t.why.dhcpRouter : undefined, 1));
    if (p.dns) lines.push(L(`dns-server ${oneLine(p.dns)}`, i === 0 ? t.why.dhcpDns : undefined, 1));
    if (p.lease) lines.push(L(`lease ${p.lease}`, undefined, 1));
    lines.push(L("exit", undefined, 1));
  });
  return { id: "dhcp", title: t.blocks.dhcp, lines };
}

/** DHCP server on a Server device (Packet Tracer: Services > DHCP, graphical). */
function dhcpGuiBlock(d: Device, an: Analysis, t: Dict): Block | null {
  const pools = an.dhcp.pools.filter((p) => p.serverId === d.id);
  if (!pools.length) return null;
  const lines: Line[] = [L("Services → DHCP → Service: On", t.why.dhcpGui)];
  pools.forEach((p) => {
    lines.push(NOTE(`// ${poolName(p)}`));
    lines.push(L(`Pool Name: ${poolName(p)}`));
    if (p.gateway !== null) lines.push(L(`Default Gateway: ${intToIp(p.gateway)}`));
    if (p.dns) lines.push(L(`DNS Server: ${oneLine(p.dns)}`));
    lines.push(L(`Start IP Address: ${intToIp(p.dynStart)}`, t.why.dhcpStart));
    lines.push(L(`Subnet Mask: ${maskStr(p.net.prefix)}`));
    lines.push(L(`Maximum Number of Users: ${p.count}`));
    lines.push(L("Save / Add"));
  });
  return { id: "dhcp", title: t.blocks.dhcpServer, lines };
}

const desc = (topo: Topology, d: Device, port: string, t: Dict) => {
  const p = peerOf(topo, d.id, port);
  const pd = p ? getDevice(topo, p.deviceId) : undefined;
  return pd ? `description ${t.comments.linkTo} ${pd.hostname} ${p!.port}` : "";
};

/** "interface range" argument from a list of ports, grouping consecutive ones. */
function rangeArg(ports: string[], all: string[]): string {
  const idx = ports.map((p) => all.indexOf(p)).sort((a, b) => a - b);
  // Ports only share a range when everything before the last number matches (Fa0/, Gig1/0/, Gig1/1/ ...).
  const type = (p: string) => p.slice(0, p.lastIndexOf("/"));
  const runs: string[][] = [];
  for (const i of idx) {
    const p = all[i];
    const last = runs[runs.length - 1];
    const prevIdx = last ? all.indexOf(last[last.length - 1]) : -9;
    if (last && prevIdx === i - 1 && type(all[prevIdx]) === type(p)) last.push(p);
    else runs.push([p]);
  }
  return runs
    .map((r) =>
      r.length === 1
        ? ifaceFull(r[0])
        : `${ifaceFull(r[0])} - ${r[r.length - 1].split("/").pop()}`,
    )
    .join(" , ");
}

function routerGuide(d: Device, topo: Topology, s: Settings, t: Dict, an: Analysis) {
  const blocks: Block[] = [basicBlock(d, s, t)];
  const model = modelById(d.model);
  const connected = model.ports.filter((p) => connectedPorts(topo, d.id).includes(p));

  const ifLines: Line[] = [];
  const subLines: Line[] = [];
  const edge = an.edges.get(d.id);
  let firstInside = true;
  const natLine = (inside: boolean) => {
    const first = inside && firstInside;
    if (inside) firstInside = false;
    return L(inside ? "ip nat inside" : "ip nat outside", inside ? (first ? t.why.natInside : undefined) : t.why.natOutside, 1);
  };
  for (const port of connected) {
    const cfg = d.ports[port] ?? {};
    const dsc = desc(topo, d, port, t);
    ifLines.push(L(`interface ${ifaceFull(port)}`));
    if (dsc) ifLines.push(L(dsc, undefined, 1));
    if (cfg.subifs?.length) {
      ifLines.push(L("no shutdown", t.why.noShut, 1));
      ifLines.push(L("exit", undefined, 1));
      for (const sub of [...cfg.subifs].sort((a, b) => a.vlan - b.vlan)) {
        const c = parseCidr(sub.ip);
        subLines.push(L(`interface ${ifaceFull(port)}.${sub.vlan}`));
        subLines.push(L(`description ${t.comments.vlan}_${sub.vlan}`, undefined, 1));
        subLines.push(L(`encapsulation dot1Q ${sub.vlan}`, t.why.dot1q, 1));
        subLines.push(
          c
            ? L(`ip address ${intToIp(c.ip)} ${maskStr(c.prefix)}`, t.why.subIp, 1)
            : NOTE("ip address ?", 1),
        );
        subLines.push(...helperLines(an, d.id, ifaceKey({ port, vlan: sub.vlan }), t));
        subLines.push(...hsrpLines(an, d.id, ifaceKey({ port, vlan: sub.vlan }), t));
        if (edge?.nat) subLines.push(natLine(true));
        subLines.push(L("exit", undefined, 1));
      }
    } else {
      const c = parseCidr(cfg.ip);
      ifLines.push(
        c ? L(`ip address ${intToIp(c.ip)} ${maskStr(c.prefix)}`, t.why.ifaceIp, 1) : NOTE("ip address ?", 1),
      );
      ifLines.push(...helperLines(an, d.id, ifaceKey({ port }), t));
      ifLines.push(...hsrpLines(an, d.id, ifaceKey({ port }), t));
      if (edge?.nat) ifLines.push(natLine(port !== edge.wanPort));
      ifLines.push(L("no shutdown", t.why.noShut, 1));
      ifLines.push(L("exit", undefined, 1));
    }
  }
  if (ifLines.length) blocks.push({ id: "interfaces", title: t.blocks.interfaces, lines: ifLines });
  if (subLines.length) blocks.push({ id: "subifs", title: t.blocks.subifs, lines: subLines });
  const dhcpBlock = dhcpCliBlock(d, an, t);
  if (dhcpBlock) blocks.push(dhcpBlock);
  const policy = policyBlock(d, an, t);
  if (policy) blocks.push(policy);
  if (edge?.nat && edge.inside.length) {
    const lines: Line[] = [L("ip access-list standard NAT_INSIDE", t.why.natAcl)];
    for (const n of edge.inside) lines.push(L(`permit ${intToIp(n.net)} ${wildcardStr(n.prefix)}`, undefined, 1));
    lines.push(L("exit", undefined, 1));
    lines.push(L(`ip nat inside source list NAT_INSIDE interface ${ifaceFull(edge.wanPort)} overload`, t.why.natOverload));
    blocks.push({ id: "nat", title: t.blocks.nat, lines });
  }

  const rs = an.routes.get(d.id) ?? [];
  if (rs.length) {
    blocks.push({
      id: "routes",
      title: t.blocks.routes,
      lines: rs.map((r, i) =>
        L(
          `ip route ${intToIp(r.net.net)} ${maskStr(r.net.prefix)} ${intToIp(r.nextHop)}`,
          r.net.prefix === 0 ? t.why.defaultRoute : i === 0 ? t.why.route : undefined,
        ),
      ),
    });
  }

  const dynamicBlock = dynBlock(d, an, t);
  if (dynamicBlock) blocks.push(dynamicBlock);

  blocks.push({
    id: "save",
    title: t.blocks.save,
    lines: [
      L("end"),
      L("write memory", t.why.save),
      L("show ip interface brief", t.verify.cmdIface),
      L("show ip route", t.verify.cmdRoute),
      ...dynVerify(d, an, t),
      ...standbyVerify(d, an, t),
      ...(dhcpBlock ? [L("show ip dhcp binding", t.verify.cmdDhcp)] : []),
      ...(edge?.nat ? [L("show ip nat translations", t.verify.cmdNat)] : []),
    ],
  });
  return blocks;
}

function switchGuide(
  d: Device,
  topo: Topology,
  s: Settings,
  t: Dict,
  an: Analysis,
) {
  const blocks: Block[] = [basicBlock(d, s, t)];
  const model = modelById(d.model);
  const used = connectedPorts(topo, d.id);
  const l3 = isL3Switch(d);

  const vlans = new Map<number, string>();
  for (const v of d.vlans ?? []) if (v.id !== 1) vlans.set(v.id, v.name || `VLAN${v.id}`);
  if (!l3 && d.mgmt && d.mgmt.vlan !== 1 && !vlans.has(d.mgmt.vlan)) vlans.set(d.mgmt.vlan, "Management");
  for (const sv of l3 ? (d.svis ?? []) : []) {
    if (sv.vlan !== 1 && !vlans.has(sv.vlan)) vlans.set(sv.vlan, `VLAN${sv.vlan}`);
  }
  if (vlans.size) {
    const lines: Line[] = [];
    [...vlans.entries()]
      .sort((a, b) => a[0] - b[0])
      .forEach(([id, name], i) => {
        lines.push(L(`vlan ${id}`, i === 0 ? t.why.vlan : undefined));
        lines.push(L(`name ${name.replace(/\s+/g, "_")}`, undefined, 1));
        lines.push(L("exit", undefined, 1));
      });
    blocks.push({ id: "vlans", title: t.blocks.vlans, lines });
  }

  if (l3) {
    blocks.push({ id: "routing", title: t.blocks.routing, lines: [L("ip routing", t.why.ipRouting)] });
    const sv = [...(d.svis ?? [])].sort((a, b) => a.vlan - b.vlan);
    if (sv.length) {
      const lines: Line[] = [];
      sv.forEach((x, i) => {
        const c = parseCidr(x.ip);
        lines.push(L(`interface vlan ${x.vlan}`, i === 0 ? t.why.svIface : undefined));
        lines.push(c ? L(`ip address ${intToIp(c.ip)} ${maskStr(c.prefix)}`, undefined, 1) : NOTE("ip address ?", 1));
        lines.push(...helperLines(an, d.id, ifaceKey({ port: `Vlan${x.vlan}`, vlan: x.vlan }), t));
        lines.push(...hsrpLines(an, d.id, ifaceKey({ port: `Vlan${x.vlan}`, vlan: x.vlan }), t));
        lines.push(L("no shutdown", undefined, 1));
        lines.push(L("exit", undefined, 1));
      });
      blocks.push({ id: "svis", title: t.blocks.svis, lines });
    }
    const routed: Line[] = [];
    let firstRouted = true;
    for (const port of model.ports.filter((p) => used.includes(p) && d.ports[p]?.mode === "routed")) {
      const c = parseCidr(d.ports[port]?.ip);
      const dsc = desc(topo, d, port, t);
      routed.push(L(`interface ${ifaceFull(port)}`));
      if (dsc) routed.push(L(dsc, undefined, 1));
      routed.push(L("no switchport", firstRouted ? t.why.routedPort : undefined, 1));
      routed.push(c ? L(`ip address ${intToIp(c.ip)} ${maskStr(c.prefix)}`, undefined, 1) : NOTE("ip address ?", 1));
      routed.push(L("no shutdown", undefined, 1));
      routed.push(L("exit", undefined, 1));
      firstRouted = false;
    }
    if (routed.length) blocks.push({ id: "routed", title: t.blocks.routed, lines: routed });
    const dhcpBlock = dhcpCliBlock(d, an, t);
    if (dhcpBlock) blocks.push(dhcpBlock);
    const policy = policyBlock(d, an, t);
    if (policy) blocks.push(policy);
  }

  // Layer-2 protections. DAI needs the DHCP snooping table, so it only runs together with snooping.
  const real = s.target === "real";
  const nativeId = Math.min(4094, Math.max(2, Math.floor(s.nativeVlanId) || 999));
  const allVlans = usedVlans(topo);
  const accessVlans = [
    ...new Set(
      model.ports
        .filter((p) => used.includes(p) && d.ports[p]?.mode !== "trunk" && d.ports[p]?.mode !== "routed")
        .map((p) => d.ports[p]?.vlan ?? 1),
    ),
  ].sort((a, b) => a - b);
  const snoop = s.dhcpSnooping && accessVlans.length > 0;
  const dai = snoop && s.dai;
  /** Ports where DHCP answers and ARP are believed: toward other switches, routers and a DHCP server. */
  const trusted = (port: string) => {
    if (d.ports[port]?.mode === "trunk") return true;
    const q = peerOf(topo, d.id, port);
    const o = q ? getDevice(topo, q.deviceId) : undefined;
    return !!o && (isL3Device(o) || o.kind === "switch" || (o.kind === "server" && an.dhcp.pools.some((p) => p.serverId === o.id)));
  };
  if (snoop) {
    const sec: Line[] = [
      L("ip dhcp snooping", t.why.snoop),
      L(`ip dhcp snooping vlan ${accessVlans.join(",")}`, t.why.snoopVlan),
      L("no ip dhcp snooping information option", t.why.snoopOpt),
    ];
    if (dai) {
      sec.push(L(`ip arp inspection vlan ${accessVlans.join(",")}`, t.why.dai));
      sec.push(L("ip arp inspection validate src-mac dst-mac ip", t.why.daiValidate));
    }
    blocks.push({ id: "l2sec", title: t.blocks.l2sec, lines: sec });
  }

  // Redundancy: spanning-tree root next to the HSRP active device, and parallel cables as one EtherChannel.
  const red = topo.redundancy;
  const myBundles = red?.etherchannel ? an.bundles.filter((b) => b.a === d.id || b.b === d.id) : [];
  const bundled = new Set(myBundles.flatMap((b) => bundlePorts(b, d.id)));
  const stp: Line[] = [];
  if (red?.rapidPvst) stp.push(L("spanning-tree mode rapid-pvst", t.why.rapid));
  if (red && red.stpAlign !== false) {
    for (const g of an.hsrpGroups) {
      if (g.vlan === undefined) continue;
      if (g.activeId === d.id) stp.push(L(`spanning-tree vlan ${g.vlan} root primary`, t.why.stpPrimary));
      else if (g.standbyIds.includes(d.id)) stp.push(L(`spanning-tree vlan ${g.vlan} root secondary`, t.why.stpSecondary));
    }
  }
  if (stp.length) blocks.push({ id: "stp", title: t.blocks.stp, lines: stp });

  if (myBundles.length) {
    const word = red?.channelMode === "pagp" ? "desirable" : red?.channelMode === "on" ? "on" : "active";
    const lines: Line[] = [];
    myBundles.forEach((b, i) => {
      const peer = getDevice(topo, b.a === d.id ? b.b : b.a);
      const members = model.ports.filter((p) => bundlePorts(b, d.id).includes(p));
      const cfg0 = d.ports[members[0]] ?? {};
      const trunkMode = cfg0.mode === "trunk";
      lines.push(L(`interface range ${rangeArg(members, model.ports)}`, i === 0 ? t.why.bundleMembers : undefined));
      if (trunkMode) {
        if (model.trunkEncap) lines.push(L("switchport trunk encapsulation dot1q", undefined, 1));
        lines.push(L("switchport mode trunk", undefined, 1));
      } else {
        lines.push(L("switchport mode access", undefined, 1));
        lines.push(L(`switchport access vlan ${cfg0.vlan ?? 1}`, undefined, 1));
      }
      lines.push(L(`channel-group ${b.id} mode ${word}`, i === 0 ? t.why.channelGroup : undefined, 1));
      lines.push(L("exit", undefined, 1));
      lines.push(L(`interface port-channel ${b.id}`, i === 0 ? t.why.portChannel : undefined));
      if (peer) lines.push(L(`description ${t.comments.linkTo} ${peer.hostname}`, undefined, 1));
      if (trunkMode) {
        if (model.trunkEncap) lines.push(L("switchport trunk encapsulation dot1q", undefined, 1));
        if (s.nativeVlan) lines.push(L(`switchport trunk native vlan ${nativeId}`, t.why.nativeVlan, 1));
        if (s.trunkAllowed && allVlans.length) lines.push(L(`switchport trunk allowed vlan ${allVlans.join(",")}`, t.why.allowedVlan, 1));
        lines.push(L("switchport mode trunk", t.why.trunk, 1));
        if (s.nonegotiate) lines.push(L("switchport nonegotiate", t.why.nonegotiate, 1));
        if (snoop) lines.push(L("ip dhcp snooping trust", t.why.snoopTrust, 1));
        if (dai) lines.push(L("ip arp inspection trust", t.why.daiTrust, 1));
      } else {
        lines.push(L("switchport mode access", undefined, 1));
        lines.push(L(`switchport access vlan ${cfg0.vlan ?? 1}`, undefined, 1));
      }
      lines.push(L("exit", undefined, 1));
    });
    blocks.push({ id: "etherchannel", title: t.blocks.etherchannel, lines });
  }

  const access: Line[] = [];
  const trunk: Line[] = [];
  let firstAccess = true;
  for (const port of model.ports.filter((p) => used.includes(p))) {
    const cfg = d.ports[port] ?? {};
    const dsc = desc(topo, d, port, t);
    if (cfg.mode === "routed" || bundled.has(port)) continue;
    if (cfg.mode === "trunk") {
      trunk.push(L(`interface ${ifaceFull(port)}`));
      if (dsc) trunk.push(L(dsc, undefined, 1));
      if (model.trunkEncap) trunk.push(L("switchport trunk encapsulation dot1q", t.why.trunkEncap, 1));
      if (s.nativeVlan) trunk.push(L(`switchport trunk native vlan ${nativeId}`, t.why.nativeVlan, 1));
      if (s.trunkAllowed && allVlans.length) trunk.push(L(`switchport trunk allowed vlan ${allVlans.join(",")}`, t.why.allowedVlan, 1));
      trunk.push(L("switchport mode trunk", t.why.trunk, 1));
      if (s.nonegotiate) trunk.push(L("switchport nonegotiate", t.why.nonegotiate, 1));
      if (snoop) trunk.push(L("ip dhcp snooping trust", t.why.snoopTrust, 1));
      if (dai) trunk.push(L("ip arp inspection trust", t.why.daiTrust, 1));
      trunk.push(L("exit", undefined, 1));
    } else {
      const f = firstAccess;
      firstAccess = false;
      const q = peerOf(topo, d.id, port);
      const toAp = !!q && getDevice(topo, q.deviceId)?.kind === "ap";
      access.push(L(`interface ${ifaceFull(port)}`));
      if (dsc) access.push(L(dsc, undefined, 1));
      access.push(L("switchport mode access", f ? t.why.access : undefined, 1));
      access.push(L(`switchport access vlan ${cfg.vlan ?? 1}`, undefined, 1));
      if (s.nonegotiate) access.push(L("switchport nonegotiate", f ? t.why.nonegotiate : undefined, 1));
      access.push(L("spanning-tree portfast", f ? t.why.portfast : undefined, 1));
      if (snoop) {
        if (trusted(port)) {
          access.push(L("ip dhcp snooping trust", t.why.snoopTrust, 1));
          if (dai) access.push(L("ip arp inspection trust", t.why.daiTrust, 1));
        } else if (!toAp) {
          access.push(L("ip dhcp snooping limit rate 15", f ? t.why.snoopRate : undefined, 1));
        }
      }
      if (s.stormControl && real) access.push(L("storm-control broadcast level 10", f ? t.why.storm : undefined, 1));
      // Behind an access point there are many devices, so one or two MAC addresses would shut the port down.
      if (toAp) access.push(NOTE(t.why.apPort, 1));
      if (s.portSecurity && !toAp) {
        access.push(L("switchport port-security", f ? t.why.portsec : undefined, 1));
        access.push(L(`switchport port-security maximum ${s.maxMac}`, undefined, 1));
        access.push(L("switchport port-security mac-address sticky", undefined, 1));
        access.push(L("switchport port-security violation shutdown", undefined, 1));
      }
      if (s.bpduguard) access.push(L("spanning-tree bpduguard enable", f ? t.why.bpdu : undefined, 1));
      access.push(L("exit", undefined, 1));
    }
  }
  if (trunk.length) blocks.push({ id: "trunk", title: t.blocks.trunkPorts, lines: trunk });
  if (access.length) blocks.push({ id: "access", title: t.blocks.accessPorts, lines: access });

  if (s.shutdownUnused) {
    const free = model.ports.filter((p) => !used.includes(p));
    if (free.length) {
      const arg = rangeArg(free, model.ports);
      blocks.push({
        id: "unused",
        title: t.blocks.unused,
        lines: [
          L(`interface ${free.length > 1 ? "range " : ""}${arg}`, t.why.unused),
          L("shutdown", undefined, 1),
          L("exit", undefined, 1),
        ],
      });
    }
  }

  const rs = l3 ? (an.routes.get(d.id) ?? []) : [];
  if (rs.length) {
    blocks.push({
      id: "routes",
      title: t.blocks.routes,
      lines: rs.map((r, i) =>
        L(
          `ip route ${intToIp(r.net.net)} ${maskStr(r.net.prefix)} ${intToIp(r.nextHop)}`,
          r.net.prefix === 0 ? t.why.defaultRoute : i === 0 ? t.why.route : undefined,
        ),
      ),
    });
  }
  const dynamicBlock = l3 ? dynBlock(d, an, t) : null;
  if (dynamicBlock) blocks.push(dynamicBlock);

  if (d.mgmt && !l3) {
    const c = parseCidr(d.mgmt.ip);
    if (c) {
      const lines: Line[] = [
        L(`interface vlan ${d.mgmt.vlan}`, t.why.svi),
        L(`ip address ${intToIp(c.ip)} ${maskStr(c.prefix)}`, undefined, 1),
        L("no shutdown", undefined, 1),
        L("exit", undefined, 1),
      ];
      if (ipToInt(d.mgmt.gateway ?? "") !== null) lines.push(L(`ip default-gateway ${d.mgmt.gateway}`, t.why.defgw));
      blocks.push({ id: "mgmt", title: t.blocks.mgmt, lines });
    }
  }

  blocks.push({
    id: "save",
    title: t.blocks.save,
    lines: [
      L("end"),
      L("write memory", t.why.save),
      L("show vlan brief", t.verify.cmdVlan),
      L("show interfaces trunk", t.verify.cmdTrunk),
      ...(l3
        ? [L("show ip interface brief", t.verify.cmdIface), L("show ip route", t.verify.cmdRoute), ...dynVerify(d, an, t)]
        : []),
      ...standbyVerify(d, an, t),
      ...(myBundles.length ? [L("show etherchannel summary", t.verify.cmdEtherchannel)] : []),
    ],
  });
  return blocks;
}

const wifiText = (v: string | undefined) => oneLine(v ?? "") || "?";

/** Access point (Packet Tracer: Config tab, Port 1) and the Wi-Fi card of a client use the same fields. */
function apWifiLines(w: Device["wifi"], t: Dict, prefix: string, channel: boolean): Line[] {
  const lines: Line[] = [L(`${prefix}SSID: ${wifiText(w?.ssid)}`, t.why.wifiSsid)];
  if (w?.security === "open") lines.push(L("Authentication: Disabled", t.why.wifiOpen));
  else {
    lines.push(L("Authentication: WPA2-PSK", t.why.wifiAuth));
    lines.push(L(`PSK Pass Phrase: ${wifiText(w?.passphrase)}`));
    lines.push(L("Encryption Type: AES"));
  }
  if (channel && w?.channel) lines.push(L(`Channel: ${w.channel}`, t.why.wifiChannel));
  return lines;
}

function apGuide(d: Device, topo: Topology, t: Dict): Block[] {
  const lines: Line[] = [];
  const wired = connectedPorts(topo, d.id).find((p) => !isRadioPort(p));
  const q = wired ? peerOf(topo, d.id, wired) : null;
  const sw = q ? getDevice(topo, q.deviceId) : undefined;
  if (sw) {
    const vlan = sw.kind === "switch" ? (sw.ports[q!.port]?.vlan ?? 1) : undefined;
    lines.push(NOTE(`// Port 0 → ${sw.hostname} ${q!.port}${vlan !== undefined ? ` (VLAN ${vlan})` : ""}`));
  }
  lines.push(...apWifiLines(d.wifi, t, "Config → Port 1 → ", true));
  return [{ id: "ap", title: t.blocks.ap, lines }];
}

/** Wireless router (Packet Tracer: GUI tab). It does NAT on its own between its LAN and the Internet port. */
function wrGuide(d: Device, t: Dict): Block[] {
  const blocks: Block[] = [];
  const wan: Line[] = [];
  if (d.useDhcp) wan.push(L("Setup → Internet Connection Type: Automatic Configuration - DHCP", t.why.wrWanDhcp));
  else {
    const c = parseCidr(d.ip);
    wan.push(L("Setup → Internet Connection Type: Static IP", t.why.wrWanStatic));
    wan.push(c ? L(`Internet IP Address: ${intToIp(c.ip)}`) : NOTE("Internet IP Address: ?"));
    if (c) wan.push(L(`Subnet Mask: ${maskStr(c.prefix)}`));
    if (d.gateway?.trim()) wan.push(L(`Default Gateway: ${d.gateway.trim()}`));
  }
  blocks.push({ id: "wr-wan", title: t.blocks.wrWan, lines: wan });

  const lan = parseCidr(d.wr?.lanIp);
  const lanLines: Line[] = [];
  if (lan) {
    lanLines.push(L(`Network Setup → Router IP: ${intToIp(lan.ip)}`, t.why.wrLan));
    lanLines.push(L(`Subnet Mask: ${maskStr(lan.prefix)}`));
    if (d.wr?.dhcp) {
      lanLines.push(L("DHCP Server: Enabled", t.why.wrDhcp));
      lanLines.push(L(`Start IP Address: ${intToIp(lan.net + (d.wr.dhcpStart ?? 100))}`));
      lanLines.push(L(`Maximum number of Users: ${d.wr.maxUsers ?? 50}`));
    } else lanLines.push(L("DHCP Server: Disabled"));
  } else lanLines.push(NOTE("Network Setup → Router IP: ?"));
  lanLines.push(L("Save Settings", t.why.wrSave));
  blocks.push({ id: "wr-lan", title: t.blocks.wrLan, lines: lanLines });

  const w = d.wifi;
  const wifi: Line[] = [L(`Wireless → Basic Wireless Settings → Network Name (SSID): ${wifiText(w?.ssid)}`, t.why.wifiSsid)];
  if (w?.channel) wifi.push(L(`Standard Channel: ${w.channel}`, t.why.wifiChannel));
  if (w?.security === "open") wifi.push(L("Wireless → Wireless Security → Security Mode: Disabled", t.why.wifiOpen));
  else {
    wifi.push(L("Wireless → Wireless Security → Security Mode: WPA2 Personal", t.why.wifiAuth));
    wifi.push(L("Encryption: AES"));
    wifi.push(L(`Passphrase: ${wifiText(w?.passphrase)}`));
  }
  wifi.push(L("Save Settings", t.why.wrSave));
  blocks.push({ id: "wr-wifi", title: t.blocks.wrWifi, lines: wifi });
  return blocks;
}

function hostGuide(d: Device, topo: Topology, t: Dict, an: Analysis) {
  const blocks: Block[] = [];
  // Joins a Wi-Fi network: the SSID and key come from the access point or wireless router it is linked to.
  const wl = topo.links.find((l) => l.wireless && (l.a === d.id || l.b === d.id));
  const radio = wl ? getDevice(topo, wl.a === d.id ? wl.b : wl.a) : undefined;
  if (radio) {
    const lines = apWifiLines(radio.wifi, t, "Config → Wireless0 → ", false);
    lines[0] = { ...lines[0], why: t.why.wifiCard };
    blocks.push({ id: "wifi", title: t.blocks.wifiClient, lines });
  }
  const c = parseCidr(d.ip);
  if (c || d.useDhcp) {
    const lines: Line[] = c && !d.useDhcp
      ? [L(`IP Address: ${intToIp(c.ip)}`, t.why.hostIp), L(`Subnet Mask: ${maskStr(c.prefix)}`)]
      : [L("IP Configuration: DHCP", t.why.hostDhcp)];
    if (!d.useDhcp && d.gateway?.trim()) lines.push(L(`Default Gateway: ${d.gateway.trim()}`));
    blocks.push({ id: "host", title: t.blocks.hostCfg, lines });
    // A server can also hand out addresses.
    const srv = dhcpGuiBlock(d, an, t);
    if (srv) blocks.push(srv);

    const tests: Line[] = [];
    if (d.useDhcp) tests.push(L("ipconfig", t.verify.cmdIpconfig));
    const gw = d.useDhcp ? an.dhcp.hosts.get(d.id)?.gateway : null;
    const gwText = d.useDhcp ? (gw != null ? intToIp(gw) : "") : (d.gateway?.trim() ?? "");
    if (gwText) tests.push(L(`ping ${gwText}`, t.verify.pingGw));
    if (an.edges.size || topo.devices.some((x) => x.kind === "wrouter")) {
      for (const n of topo.devices) {
        const ip = n.kind === "internet" ? ipToInt(n.testIp ?? "") : null;
        if (ip !== null) tests.push(L(`ping ${intToIp(ip)}`, t.verify.pingInternet));
      }
    }
    let first = true;
    for (const o of topo.devices) {
      if (o.id === d.id || (o.kind !== "pc" && o.kind !== "server") || o.useDhcp) continue;
      const oc = parseCidr(o.ip);
      if (!oc) continue;
      tests.push(L(`ping ${intToIp(oc.ip)}`, first ? `${t.verify.pingRemote} (${o.hostname})` : o.hostname));
      first = false;
    }
    if (tests.length) blocks.push({ id: "test", title: t.blocks.hostTest, lines: tests });
  }
  return blocks;
}

export function generate(topo: Topology, s: Settings, t: Dict): DeviceGuide[] {
  const an = analyze(topo);
  // L2 switches first, then routing devices (routers and multilayer switches), then hosts.
  const rank = (d: Device) =>
    d.kind === "switch" && !isL3Switch(d)
      ? 0
      : isL3Device(d)
        ? 1
        : d.kind === "internet"
          ? 2
          : d.kind === "wrouter"
            ? 3
            : d.kind === "ap"
              ? 4
              : d.kind === "server"
                ? 5
                : 6;
  const sorted = [...topo.devices].sort((a, b) => rank(a) - rank(b));
  return sorted.map((d) => ({
    deviceId: d.id,
    hostname: d.hostname,
    kind: d.kind,
    model: d.model,
    blocks:
      d.kind === "router"
        ? routerGuide(d, topo, s, t, an)
        : d.kind === "switch"
          ? switchGuide(d, topo, s, t, an)
          : d.kind === "internet"
            ? ispGuide(d, topo, t, an)
            : d.kind === "ap"
              ? apGuide(d, topo, t)
              : d.kind === "wrouter"
                ? wrGuide(d, t)
                : hostGuide(d, topo, t, an),
  }));
}
