import { useState } from "react";
import type { Dict } from "../i18n";
import type { Block, DeviceGuide, Line } from "../lib/types";
import { isL3Switch, modelById } from "../lib/catalog";
import { KindIcon } from "./FlowParts";

const toText = (lines: Line[]) =>
  lines
    .filter((l) => !l.note)
    .map((l) => "  ".repeat(l.indent ?? 0) + l.text)
    .join("\n");

function CopyButton({ text, t, label }: { text: string; t: Dict; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded border border-white/10 text-slate-400 hover:text-white hover:bg-white/5 transition"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {done ? t.actions.copied : (label ?? t.actions.copy)}
    </button>
  );
}

function CliBlock({ n, block, showWhy, t }: { n: string; block: Block; showWhy: boolean; t: Dict }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-emerald-400 font-bold tracking-widest uppercase italic underline decoration-emerald-500/30">
          // {n} {block.title}
        </p>
        <CopyButton text={toText(block.lines)} t={t} />
      </div>
      <div className="p-4 text-blue-100 bg-black/40 rounded-xl border border-white/5 text-sm font-mono overflow-x-auto leading-tight space-y-0.5">
        {block.lines.map((l, i) => (
          <div key={i}>
            <p className={l.note ? "text-slate-500 italic" : ""} style={{ paddingLeft: `${(l.indent ?? 0) * 1}rem` }}>
              {l.text}
            </p>
            {showWhy && l.why && (
              <p className="mb-1 text-[12px] text-orange-400/80 italic font-sans" style={{ paddingLeft: `${(l.indent ?? 0) * 1}rem` }}>
                » {l.why}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function GuideOutput({ guides, showWhy, t }: { guides: DeviceGuide[]; showWhy: boolean; t: Dict }) {
  if (!guides.length) return <p className="text-sm text-slate-500 italic">{t.guide.empty}</p>;
  const r = t.remember;
  return (
    <div className="space-y-10">
      <p className="text-sm text-slate-400 italic">{t.guide.order}</p>
      {guides.map((g, gi) => (
        <section key={g.deviceId} className="p-8 bg-slate-900 rounded-3xl border border-white/5 shadow-2xl">
          <div className="flex items-center justify-between mb-6">
            <h3 className="flex items-center gap-3 text-xl font-bold text-blue-500 uppercase">
              <KindIcon kind={g.kind} size={28} l3={isL3Switch(g)} />
              <span>
                {gi + 1}. {g.hostname} <span className="text-white font-medium">({modelById(g.model).label})</span>
              </span>
            </h3>
            <CopyButton
              text={g.blocks.map((b) => toText(b.lines)).join("\n")}
              t={t}
              label={t.actions.copyAll}
            />
          </div>
          {(g.kind === "router" || g.kind === "switch" || g.kind === "internet") && (
            <div className="mb-6 pl-3 border-l-2 border-blue-500/50">
              <p className="text-[12px] text-white tracking-widest leading-relaxed italic">
                {r.a} <span className="text-blue-400">{r.b}</span> {r.c} <span className="text-blue-400">{r.d}</span>
                {r.e}
              </p>
            </div>
          )}
          <div className="space-y-6">
            {g.blocks.map((b, bi) => (
              <CliBlock key={b.id} n={`${gi + 1}.${bi + 1}`} block={b} showWhy={showWhy} t={t} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
