import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  Background,
  Controls,
  ConnectionMode,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import { dictionaries, fmt, type Lang } from "../i18n";
import { analyze, lanNetworks, linkNetwork } from "../lib/analyze";
import { MODELS } from "../lib/catalog";
import { EXAMPLE, exampleFor, exampleRedundant } from "../lib/example";
import { parseCidr } from "../lib/net";
import { applyScheme, normalize, schemeOf } from "../lib/scheme";
import { downloadText, guideToMarkdown, guideToText } from "../lib/exporter";
import { buildPlan, settingsIssues } from "../lib/verify";
import { generate } from "../lib/generate";
import {
  addDevice,
  connect,
  emptyTopology,
  isTopology,
  removeDevice,
  removeLink,
  updateDevice,
} from "../lib/topology";
import { DEFAULT_SETTINGS, type Scheme, type Settings, type Topology } from "../lib/types";
import { DeviceNode, KindIcon, LinkEdge, type DevNode, type LinkEdgeT } from "./FlowParts";
import GuideOutput from "./GuideOutput";
import Inspector, { type Selection } from "./Inspector";
import PlanPanel from "./PlanPanel";
import PolicyPanel from "./PolicyPanel";
import RedundancyPanel from "./RedundancyPanel";
import RoutingPanel from "./RoutingPanel";

const nodeTypes = { device: DeviceNode };
const edgeTypes = { link: LinkEdge };
const STORE = "guia-interactiva:v1";

function load(): { topo: Topology; settings: Settings } {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const j = JSON.parse(raw);
      if (isTopology(j.topology)) return { topo: normalize(j.topology), settings: { ...DEFAULT_SETTINGS, ...j.settings } };
    }
  } catch {
    /* ignore corrupted storage */
  }
  return { topo: EXAMPLE, settings: DEFAULT_SETTINGS };
}

const btn =
  "px-3 py-1.5 text-[11px] font-bold tracking-wider uppercase rounded-lg border border-white/10 text-slate-300 hover:text-white hover:bg-white/5 transition";
const inputCls =
  "w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-xs font-mono text-blue-100 outline-none focus:border-blue-500";

const H2 = ({ id, children }: { id: string; children: string }) => (
  <h2 id={id} className="mb-8 pl-4 text-3xl font-bold text-white tracking-tighter border-l-4 border-blue-500 uppercase scroll-mt-24">
    {children}
  </h2>
);

function EditorInner({ lang }: { lang: Lang }) {
  const t = dictionaries[lang];
  const initial = useMemo(load, []);
  const [topo, setTopo] = useState<Topology>(initial.topo);
  const [settings, setSettings] = useState<Settings>(initial.settings);
  const [sel, setSel] = useState<Selection>(null);
  const [showNets, setShowNets] = useState(true);
  // Analysis, commands and network labels work on the topology translated for the chosen scheme.
  const effective = useMemo(() => applyScheme(topo), [topo]);
  const [toast, setToast] = useState("");
  const [showWhy, setShowWhy] = useState(true);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const fileRef = useRef<HTMLInputElement>(null);

  // Persist on every change.
  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify({ topology: topo, settings }));
    } catch {
      /* storage full or disabled */
    }
  }, [topo, settings]);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 3500);
  };

  // React Flow reports node sizes through change events; since nodes are derived
  // from the topology, the measured sizes are kept here and fed back to it.
  const [dims, setDims] = useState<Record<string, { width: number; height: number }>>({});

  const nodes: DevNode[] = useMemo(
    () =>
      topo.devices.map((d) => ({
        id: d.id,
        type: "device",
        position: { x: d.x, y: d.y },
        data: { device: d },
        measured: dims[d.id],
        selected: sel?.type === "device" && sel.id === d.id,
      })),
    [topo.devices, sel, dims],
  );

  const edges: LinkEdgeT[] = useMemo(
    () =>
      topo.links.map((l) => ({
        id: l.id,
        type: "link",
        source: l.a,
        target: l.b,
        sourceHandle: l.aHandle,
        targetHandle: l.bHandle,
        selected: sel?.type === "link" && sel.id === l.id,
        data: {
          aLabel: l.wireless ? "" : l.aPort,
          bLabel: l.wireless ? "" : l.bPort,
          net: showNets ? (linkNetwork(effective, l) ?? undefined) : undefined,
          wireless: l.wireless,
          wifi: l.wireless
            ? (topo.devices.find((d) => (d.id === l.a || d.id === l.b) && d.wifi)?.wifi?.ssid?.trim() ?? "")
            : undefined,
        },
      })),
    [topo.links, topo.devices, sel, effective, showNets],
  );

  const onNodesChange = useCallback((changes: NodeChange<DevNode>[]) => {
    for (const ch of changes) {
      if (ch.type === "position" && ch.position) {
        const { x, y } = ch.position;
        setTopo((cur) => updateDevice(cur, ch.id, { x, y }));
      } else if (ch.type === "dimensions" && ch.dimensions) {
        const { width, height } = ch.dimensions;
        setDims((prev) =>
          prev[ch.id]?.width === width && prev[ch.id]?.height === height ? prev : { ...prev, [ch.id]: { width, height } },
        );
      } else if (ch.type === "remove") {
        setTopo((cur) => removeDevice(cur, ch.id));
        setSel((s) => (s?.id === ch.id ? null : s));
      }
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<LinkEdgeT>[]) => {
    for (const ch of changes) {
      if (ch.type === "remove") {
        setTopo((cur) => removeLink(cur, ch.id));
        setSel((s) => (s?.id === ch.id ? null : s));
      }
    }
  }, []);

  const onConnect = (c: Connection) => {
    const r = connect(topo, c.source, c.sourceHandle ?? undefined, c.target, c.targetHandle ?? undefined);
    if (!r) return;
    if (!r.ok) return flash(fmt(r.reason === "busy" ? t.canvas.wifiBusy : t.canvas.noFreePort, { dev: r.dev }));
    setTopo(r.topo);
    setSel({ type: "link", id: r.linkId });
  };

  const place = (modelId: string, x: number, y: number) => {
    const r = addDevice(topo, modelId, x, y);
    setTopo(r.topo);
    setSel({ type: "device", id: r.id });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const model = e.dataTransfer.getData("application/x-model");
    if (!model) return;
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    place(model, p.x - 50, p.y - 40);
  };

  const replaceTopology = (next: Topology) => {
    setTopo(next);
    setSel(null);
    setTimeout(() => fitView({ padding: 0.2 }), 50);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ version: 1, topology: topo, settings }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "topology.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importJson = async (file: File) => {
    try {
      const j = JSON.parse(await file.text());
      const tp = j.topology ?? j;
      if (!isTopology(tp)) throw new Error("invalid");
      replaceTopology(normalize(tp));
      if (j.settings) setSettings({ ...DEFAULT_SETTINGS, ...j.settings });
    } catch {
      flash(t.actions.importError);
    }
  };

  const analysis = useMemo(() => analyze(effective), [effective]);
  const guides = useMemo(() => generate(effective, settings, t), [effective, settings, t]);
  const scheme = schemeOf(topo);
  const allIssues = useMemo(() => [...analysis.issues, ...settingsIssues(effective, settings)], [analysis, effective, settings]);
  const plan = useMemo(() => buildPlan(effective, analysis, settings, t), [effective, analysis, settings, t]);
  const exportSummary = `${t.schemes[scheme].name} · ${t.routing[topo.routing?.protocol ?? "static"].name}`;
  const exportAs = (kind: "txt" | "md") => {
    const o = { why: showWhy, summary: exportSummary };
    if (kind === "txt") downloadText("guia-configuracion.txt", guideToText(guides, plan, t, o));
    else downloadText("guia-configuracion.md", guideToMarkdown(guides, plan, t, o), "text/markdown");
  };
  const setScheme = (s: Scheme) => setTopo((cur) => ({ ...cur, scheme: s }));
  const setS = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  const textField = (k: "domain" | "username" | "password" | "enableSecret" | "banner", label: string) => (
    <label className="block">
      <span className="block mb-1 text-[10px] font-bold tracking-widest text-slate-400 uppercase">{label}</span>
      <input className={inputCls} value={settings[k]} onChange={(e) => setS(k, e.target.value)} />
    </label>
  );
  const check = (
    k:
      | "portSecurity"
      | "bpduguard"
      | "shutdownUnused"
      | "execTimeout"
      | "sshAcl"
      | "sshHardening"
      | "loginBlock"
      | "noCdp"
      | "noHttp"
      | "nativeVlan"
      | "trunkAllowed"
      | "nonegotiate"
      | "dhcpSnooping"
      | "dai"
      | "stormControl",
    label: string,
    opts?: { disabled?: boolean; help?: string },
  ) => (
    <div className={opts?.disabled ? "opacity-50" : ""}>
      <label className="flex items-center gap-2 text-sm text-slate-200">
        <input type="checkbox" disabled={opts?.disabled} checked={settings[k]} onChange={(e) => setS(k, e.target.checked)} />
        {label}
      </label>
      {opts?.help && <p className="mt-1 ml-6 text-xs text-slate-400 italic">{opts.help}</p>}
    </div>
  );

  return (
    <>
      <section id="topology" className="mb-24 print:hidden">
        <H2 id="topology-h">{t.nav.topology}</H2>

        <div className="mb-8 p-6 bg-slate-900 rounded-3xl border border-white/5">
          <h3 className="mb-2 text-lg font-bold text-blue-400 uppercase italic">{t.schemes.title}</h3>
          <p className="mb-5 text-sm text-slate-400 italic">{t.schemes.intro}</p>
          <div className="flex flex-wrap gap-2 p-1 mb-4 bg-white/5 rounded-lg border border-white/10 w-fit" role="radiogroup">
            {(["roas", "core", "advanced"] as const).map((k) => (
              <button
                key={k}
                role="radio"
                aria-checked={scheme === k}
                onClick={() => setScheme(k)}
                className={`px-4 py-2 text-[11px] font-bold rounded uppercase tracking-tighter transition-all ${
                  scheme === k ? "bg-blue-500/20 text-blue-400" : "text-slate-500 hover:text-white"
                }`}
              >
                {t.schemes[k].name}
              </button>
            ))}
          </div>
          <p className="text-sm text-slate-300">{t.schemes[scheme].desc}</p>
          <p className="mt-2 text-xs text-slate-500 italic">{t.schemes[scheme].how}</p>
          <div className="flex flex-wrap items-center gap-3 mt-4">
            <button className={btn} onClick={() => replaceTopology(exampleFor(scheme))}>
              {t.schemes.load}
            </button>
            <span className="text-xs text-slate-500 italic">{t.schemes.exampleNote}</span>
          </div>
        </div>

        <RoutingPanel topo={topo} setTopo={setTopo} t={t} />
        <RedundancyPanel topo={topo} effective={effective} setTopo={setTopo} t={t} onLoadExample={() => replaceTopology(exampleRedundant())} />

        <div className="flex flex-wrap items-center gap-3 mb-4">
          {MODELS.map((m) => (
            <button
              key={m.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-model", m.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => place(m.id, 60 + (topo.devices.length % 6) * 130, 60 + Math.floor(topo.devices.length / 6) * 130)}
              className="flex items-center gap-2 px-3 py-2 text-xs font-bold text-white rounded-xl bg-slate-900 border border-white/10 hover:border-blue-500/50 cursor-grab active:cursor-grabbing"
              title={t.palette.hint}
            >
              <KindIcon kind={m.kind} size={20} l3={m.layer3} />
              {m.label}
            </button>
          ))}
        </div>
        <p className="mb-4 text-xs text-slate-500 italic">{t.palette.hint} {t.canvas.hint}</p>

        <div className="relative">
          <div
            className="relative h-[680px] rounded-3xl border border-white/10 overflow-hidden bg-[#050b1c]"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={onDrop}
          >
            <ReactFlow<DevNode, LinkEdgeT>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              connectionMode={ConnectionMode.Loose}
              isValidConnection={(c) => c.source !== c.target}
              onNodeClick={(_, n) => setSel({ type: "device", id: n.id })}
              onEdgeClick={(_, e) => setSel({ type: "link", id: e.id })}
              onPaneClick={() => setSel(null)}
              colorMode="dark"
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.3}
              deleteKeyCode={["Delete", "Backspace"]}
            >
              <Background gap={24} color="#1e293b" />
              <Controls showInteractive={false} />
            </ReactFlow>
            {!topo.devices.length && (
              <p className="absolute inset-0 flex items-center justify-center text-sm text-slate-500 italic pointer-events-none">
                {t.canvas.empty}
              </p>
            )}
            {toast && (
              <p className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 text-xs text-white rounded-lg bg-red-900/80 border border-red-500/40">
                {toast}
              </p>
            )}
          </div>

          {/* Wide screens: the panel sits in the right margin, level with the canvas. Narrower ones: below it. */}
          <div className="mt-6 min-[1800px]:absolute min-[1800px]:top-0 min-[1800px]:left-full min-[1800px]:mt-0 min-[1800px]:ml-6 min-[1800px]:h-[680px] min-[1800px]:w-[340px]">
            <aside className="p-6 bg-slate-900 rounded-3xl border border-white/5 shadow-2xl overflow-y-auto max-h-[600px] min-[1800px]:h-full min-[1800px]:max-h-none">
              <h3 className="mb-4 text-lg font-bold text-blue-400 uppercase italic">{t.inspector.title}</h3>
              <Inspector topo={topo} setTopo={setTopo} sel={sel} t={t} onDeselect={() => setSel(null)} />
            </aside>
          </div>
        </div>

        <label className="flex items-center gap-2 mt-4 text-xs text-slate-300">
          <input type="checkbox" checked={showNets} onChange={(e) => setShowNets(e.target.checked)} />
          {t.canvas.showNets}
        </label>

        <div className="flex flex-wrap gap-2 mt-4">
          <button
            className={btn}
            onClick={() => {
              if (!topo.devices.length || confirm(t.actions.confirmClear)) replaceTopology(emptyTopology());
            }}
          >
            {t.actions.clear}
          </button>
          <button className={btn} onClick={exportJson}>{t.actions.exportJson}</button>
          <button className={btn} onClick={() => fileRef.current?.click()}>{t.actions.importJson}</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importJson(f);
              e.target.value = "";
            }}
          />
        </div>
      </section>

      <section id="settings" className="mb-24 print:hidden">
        <H2 id="settings-h">{t.nav.settings}</H2>
        <div className="space-y-6">
          <div className="p-8 bg-slate-900 rounded-3xl border border-white/5">
            <h3 className="mb-4 text-lg font-bold text-blue-400 uppercase italic">{t.settings.groupTarget}</h3>
            <div className="flex flex-wrap gap-2 p-1 mb-3 bg-white/5 rounded-lg border border-white/10 w-fit" role="radiogroup">
              {(["pt", "real"] as const).map((k) => (
                <button
                  key={k}
                  role="radio"
                  aria-checked={settings.target === k}
                  onClick={() => setS("target", k)}
                  className={`px-4 py-2 text-[11px] font-bold rounded uppercase tracking-tighter transition-all ${
                    settings.target === k ? "bg-blue-500/20 text-blue-400" : "text-slate-500 hover:text-white"
                  }`}
                >
                  {k === "pt" ? t.settings.targetPt : t.settings.targetReal}
                </button>
              ))}
            </div>
            <p className="text-sm text-slate-300">{settings.target === "pt" ? t.settings.targetHelpPt : t.settings.targetHelpReal}</p>
          </div>

          <div className="p-8 bg-slate-900 rounded-3xl border border-white/5">
            <h3 className="mb-4 text-lg font-bold text-blue-400 uppercase italic">{t.settings.groupBasic}</h3>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {textField("domain", t.settings.domain)}
              {textField("username", t.settings.username)}
              {textField("password", t.settings.password)}
              {textField("enableSecret", t.settings.enableSecret)}
              {textField("banner", t.settings.banner)}
            </div>
          </div>

          <div className="p-8 bg-slate-900 rounded-3xl border border-white/5">
            <h3 className="mb-4 text-lg font-bold text-blue-400 uppercase italic">{t.settings.groupPorts}</h3>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <label className="block">
                <span className="block mb-1 text-[10px] font-bold tracking-widest text-slate-400 uppercase">{t.settings.maxMac}</span>
                <input
                  className={inputCls}
                  type="number"
                  min={1}
                  max={132}
                  value={settings.maxMac}
                  onChange={(e) => setS("maxMac", Math.min(132, Math.max(1, parseInt(e.target.value, 10) || 1)))}
                />
              </label>
              <div className="space-y-2 md:col-span-2 lg:col-span-3">
                {check("portSecurity", t.settings.portSecurity)}
                {check("bpduguard", t.settings.bpduguard)}
                {check("shutdownUnused", t.settings.shutdownUnused)}
              </div>
            </div>
          </div>

          <div className="p-8 bg-slate-900 rounded-3xl border border-white/5">
            <h3 className="mb-2 text-lg font-bold text-blue-400 uppercase italic">{t.settings.groupL2}</h3>
            <p className="mb-4 text-sm text-slate-300 italic">{t.settings.l2Help}</p>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-4">
                {check("nativeVlan", t.settings.nativeVlan)}
                {settings.nativeVlan && (
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    {t.settings.nativeVlanId}
                    <input
                      className={`${inputCls} !w-24`}
                      type="number"
                      min={2}
                      max={4094}
                      value={settings.nativeVlanId}
                      onChange={(e) => setS("nativeVlanId", Math.min(4094, Math.max(2, parseInt(e.target.value, 10) || 999)))}
                    />
                  </label>
                )}
              </div>
              {check("trunkAllowed", t.settings.trunkAllowed)}
              {check("nonegotiate", t.settings.nonegotiate)}
              {check("dhcpSnooping", t.settings.dhcpSnooping)}
              {check("dai", t.settings.dai, { help: t.settings.daiHelp })}
              {check("stormControl", t.settings.stormControl, {
                disabled: settings.target === "pt",
                help: settings.target === "pt" ? t.settings.stormPtOnly : undefined,
              })}
            </div>
          </div>

          <div className="p-8 bg-slate-900 rounded-3xl border border-white/5">
            <h3 className="mb-2 text-lg font-bold text-blue-400 uppercase italic">{t.settings.groupAdmin}</h3>
            <p className="mb-4 text-sm text-slate-400 italic">{t.settings.adminHelp}</p>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-4">
                {check("execTimeout", t.settings.execTimeout)}
                {settings.execTimeout && (
                  <label className="flex items-center gap-2 text-xs text-slate-400">
                    {t.settings.execTimeoutMin}
                    <input
                      className={`${inputCls} !w-20`}
                      type="number"
                      min={1}
                      max={60}
                      value={settings.execTimeoutMin}
                      onChange={(e) => setS("execTimeoutMin", Math.min(60, Math.max(1, parseInt(e.target.value, 10) || 1)))}
                    />
                  </label>
                )}
              </div>
              <div className="space-y-2">
                {check("sshAcl", t.settings.sshAcl)}
                {settings.sshAcl && (
                  <label className="block max-w-sm pl-6">
                    <span className="block mb-1 text-[10px] font-bold tracking-widest text-slate-400 uppercase">{t.settings.sshNet}</span>
                    <input
                      className={inputCls}
                      list="ssh-nets"
                      placeholder="192.168.10.0/24"
                      value={settings.sshNet}
                      onChange={(e) => setS("sshNet", e.target.value)}
                    />
                    <datalist id="ssh-nets">
                      {lanNetworks(effective).map((n) => (
                        <option key={n.key} value={n.key} />
                      ))}
                    </datalist>
                    <span className={`block mt-1 text-[11px] italic ${parseCidr(settings.sshNet) ? "text-slate-500" : "text-amber-300"}`}>
                      {parseCidr(settings.sshNet) ? t.settings.sshNetHelp : t.settings.sshNetMissing}
                    </span>
                  </label>
                )}
              </div>
              {check("sshHardening", t.settings.sshHardening)}
              {check("loginBlock", t.settings.loginBlock)}
              {check("noCdp", t.settings.noCdp)}
              {check("noHttp", t.settings.noHttp)}
            </div>
          </div>

          <PolicyPanel topo={topo} effective={effective} setTopo={setTopo} t={t} />
        </div>
      </section>

      <section id="issues" className="mb-24 print:hidden">
        <H2 id="issues-h">{t.nav.issues}</H2>
        <div className="p-8 bg-slate-900 rounded-3xl border border-white/5">
          {!allIssues.length ? (
            <p className="text-sm text-emerald-400">✓ {t.issues.ok}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {allIssues.map((i, k) => (
                <li key={k} className="flex items-start gap-3">
                  <span
                    className={`px-2 py-0.5 text-[10px] font-bold uppercase rounded ${
                      i.level === "error" ? "bg-red-500/20 text-red-300" : "bg-amber-500/20 text-amber-300"
                    }`}
                  >
                    {t.issues[i.level]}
                  </span>
                  <span className="text-slate-300">
                    {fmt(t.issues.msg[i.code as keyof typeof t.issues.msg] ?? i.code, i.args)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section id="guide" className="mb-32">
        <H2 id="guide-h">{t.nav.guide}</H2>
        <p className="mb-4 text-sm text-slate-400">
          {t.guide.scheme}: <span className="font-bold text-blue-400">{t.schemes[scheme].name}</span>
          <span className="mx-3 text-slate-600">·</span>
          {t.guide.routing}: <span className="font-bold text-blue-400">{t.routing[topo.routing?.protocol ?? "static"].name}</span>
        </p>
        <label className="flex items-center gap-2 mb-4 text-xs text-slate-300 print:hidden">
          <input type="checkbox" checked={showWhy} onChange={(e) => setShowWhy(e.target.checked)} />
          {t.guide.showWhy}
        </label>
        <div className="flex flex-wrap gap-2 mb-6 print:hidden">
          <button className={btn} onClick={() => exportAs("txt")} disabled={!guides.length}>{t.actions.downloadTxt}</button>
          <button className={btn} onClick={() => exportAs("md")} disabled={!guides.length}>{t.actions.downloadMd}</button>
          <button className={btn} onClick={() => window.print()}>{t.actions.print}</button>
        </div>
        <GuideOutput guides={guides} showWhy={showWhy} t={t} />
      </section>

      <section id="plan" className="mb-32">
        <H2 id="plan-h">{t.nav.plan}</H2>
        <PlanPanel plan={plan} t={t} />
      </section>
    </>
  );
}

export default function Editor({ lang }: { lang: Lang }) {
  return (
    <ReactFlowProvider>
      <EditorInner lang={lang} />
    </ReactFlowProvider>
  );
}
