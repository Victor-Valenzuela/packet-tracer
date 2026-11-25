import type { Dict } from "../i18n";
import { modelById } from "./catalog";
import type { DeviceGuide, Line } from "./types";
import type { PlanGroup } from "./verify";

export interface ExportOptions {
  /** Include the explanation of each command as a comment. */
  why: boolean;
  /** "Router on a Stick · RIPv2": what the guide was generated for. */
  summary: string;
}

/** One space per indentation level, which is what IOS prints and accepts when pasted. */
const pad = (l: Line) => " ".repeat(l.indent ?? 0);

/** Lines of a block as plain text. Notes and explanations become `!` comments, which IOS ignores when pasted. */
function blockLines(lines: Line[], why: boolean): string[] {
  const out: string[] = [];
  for (const l of lines) {
    out.push(l.note ? `${pad(l)}! ${l.text}` : `${pad(l)}${l.text}`);
    if (why && l.why) out.push(`${pad(l)}! » ${l.why}`);
  }
  return out;
}

const deviceTitle = (g: DeviceGuide, i: number) => `${i + 1}. ${g.hostname} (${modelById(g.model).label})`;

function planLines(plan: PlanGroup[], t: Dict, md: boolean): string[] {
  const out: string[] = [];
  for (const g of plan) {
    out.push(md ? `### ${g.title}` : `! ----- ${g.title}`);
    out.push(md ? `_${g.hint}_` : `! ${g.hint}`);
    for (const it of g.items) {
      const tag = t.plan.outcome[it.outcome];
      out.push(
        md
          ? `- [ ] **${it.where}** \`${it.command}\` — ${tag}. ${it.expected}`
          : `[ ] ${it.where}: ${it.command}  ->  ${tag}. ${it.expected}`,
      );
    }
    out.push("");
  }
  return out;
}

/** Plain text, one section per device. */
export function guideToText(guides: DeviceGuide[], plan: PlanGroup[], t: Dict, o: ExportOptions): string {
  const out: string[] = [`! ${t.nav.guide}`, `! ${o.summary}`, ""];
  guides.forEach((g, i) => {
    out.push(`! ===== ${deviceTitle(g, i)} =====`);
    g.blocks.forEach((b, j) => {
      out.push(`! ----- ${i + 1}.${j + 1} ${b.title}`);
      out.push(...blockLines(b.lines, o.why));
    });
    out.push("");
  });
  if (plan.length) {
    out.push(`! ===== ${t.plan.title} =====`, ...planLines(plan, t, false));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Markdown: a heading per device, a code block per step and the tests as a checklist. */
export function guideToMarkdown(guides: DeviceGuide[], plan: PlanGroup[], t: Dict, o: ExportOptions): string {
  const out: string[] = [`# ${t.nav.guide}`, "", `_${o.summary}_`, ""];
  guides.forEach((g, i) => {
    out.push(`## ${deviceTitle(g, i)}`, "");
    g.blocks.forEach((b, j) => {
      out.push(`### ${i + 1}.${j + 1} ${b.title}`, "", "```text", ...blockLines(b.lines, o.why), "```", "");
    });
  });
  if (plan.length) {
    out.push(`## ${t.plan.title}`, "", t.plan.intro, "", ...planLines(plan, t, true));
  }
  return out.join("\n").trimEnd() + "\n";
}

export function downloadText(filename: string, text: string, mime = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
