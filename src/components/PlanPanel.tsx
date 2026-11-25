import { useEffect, useState } from "react";
import { fmt, type Dict } from "../i18n";
import type { PlanGroup } from "../lib/verify";

const STORE = "guia-interactiva:plan-done:v1";

const outcomeCls = {
  ok: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  fail: "bg-red-500/15 text-red-300 border-red-500/30",
  info: "bg-slate-500/15 text-slate-300 border-slate-500/30",
} as const;

function loadDone(): Set<string> {
  try {
    const raw = localStorage.getItem(STORE);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** The tests to run after configuring, with a tick box each. Ticks are remembered in the browser. */
export default function PlanPanel({ plan, t }: { plan: PlanGroup[]; t: Dict }) {
  const tp = t.plan;
  const [done, setDone] = useState<Set<string>>(() => loadDone());
  const [copied, setCopied] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify([...done]));
    } catch {
      /* storage full or disabled */
    }
  }, [done]);

  const items = plan.flatMap((g) => g.items);
  const ticked = items.filter((i) => done.has(i.id)).length;
  const toggle = (id: string, on: boolean) =>
    setDone((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  if (!items.length) return <p className="text-sm text-slate-500 italic">{tp.empty}</p>;

  return (
    <div className="space-y-8">
      <p className="text-base text-slate-300 italic leading-relaxed">{tp.intro}</p>
      <div className="flex flex-wrap items-center gap-4 print:hidden">
        <div className="flex-1 min-w-[220px]">
          <p className="mb-1 text-sm font-bold tracking-widest text-slate-200 uppercase">{fmt(tp.progress, { done: ticked, total: items.length })}</p>
          <div className="h-2 overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${(ticked / items.length) * 100}%` }} />
          </div>
        </div>
        <button
          className="px-4 py-2 text-xs font-bold tracking-wider uppercase rounded-lg border border-white/10 text-slate-300 hover:text-white hover:bg-white/5 transition"
          onClick={() => setDone(new Set())}
        >
          {tp.reset}
        </button>
      </div>

      {plan.map((g) => (
        <section key={g.id} className="p-6 bg-slate-900 rounded-3xl border border-white/5 break-inside-avoid">
          <h3 className="mb-2 text-xl font-bold text-blue-400 uppercase italic">{g.title}</h3>
          <p className="mb-5 text-base text-slate-300 italic leading-relaxed">{g.hint}</p>
          <ul className="space-y-2">
            {g.items.map((i) => (
              <li key={i.id} className={`flex flex-wrap items-center gap-x-3 gap-y-2 p-4 rounded-xl bg-black/30 border border-white/5 ${done.has(i.id) ? "opacity-50" : ""}`}>
                <input type="checkbox" className="w-4 h-4" checked={done.has(i.id)} onChange={(e) => toggle(i.id, e.target.checked)} aria-label={`${i.where}: ${i.command}`} />
                <span className="px-2.5 py-1 text-sm font-bold text-white rounded bg-white/10" title={tp.where}>
                  {i.where}
                </span>
                <code className="px-2.5 py-1 text-sm font-mono text-blue-100 rounded bg-black/40">{i.command}</code>
                <span className={`px-2.5 py-1 text-xs font-bold uppercase rounded border ${outcomeCls[i.outcome]}`}>{tp.outcome[i.outcome]}</span>
                <button
                  className="ml-auto px-3 py-1 text-xs font-bold uppercase rounded border border-white/10 text-slate-300 hover:text-white print:hidden"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(i.command);
                      setCopied(i.id);
                      setTimeout(() => setCopied(""), 1200);
                    } catch {
                      /* clipboard unavailable */
                    }
                  }}
                >
                  {copied === i.id ? tp.copied : tp.copy}
                </button>
                <p className="w-full pl-7 text-sm leading-relaxed text-slate-300">{i.expected}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
