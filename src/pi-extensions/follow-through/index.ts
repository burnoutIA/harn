// follow-through — extension Pi : un modèle qui annonce du travail doit le faire.
//
// Les modèles locaux finissent parfois leur tour sur une annonce (« Plusieurs bugs à corriger, je
// les corrige : » suivi de la liste) sans appeler d'outil : pour pi, un message sans outil termine
// le travail, et rien n'est fait. Mesuré le 2026-11-01 (Swift 27B, 10 modules à écrire) : arrêt à
// 26 tests sur 36 sur une telle annonce.
//
// Juste avant que le tour se termine (agent_before_settle), si l'agent a travaillé avec des outils
// pendant ce tour et que son dernier message annonce une action, il est relancé pour la faire : deux
// fois au plus par tour. Une discussion sans outil n'est jamais relancée.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_NUDGES = 2;
const NUDGE =
  "You ended your turn by announcing work that you have not done. Do it now with your tools, without repeating the plan. " +
  "If everything is actually finished, give your final summary instead.";

// La fin du message suffit : c'est là que se trouve l'annonce, avant la liste qu'elle introduit.
const TAIL_CHARS = 700;
const ANNOUNCE = [
  /\bje\s+(?:(?:les|le|la|l'|m'|m'en|y|vais|vais\s+maintenant)\s+)*(?:corrige|analyse|lance|commence|regarde|implémente|écris|teste|vérifie|reprends|occupe|attaque|passe\s+à|ajoute|modifie|relance|cherche)\b/i,
  /\b(?:je\s+vais|on\s+va|maintenant,?\s+je|ensuite,?\s+je|passons\s+à|voyons)\b/i,
  /\b(?:let\s+me|let's|i'll|i\s+will|i\s+am\s+going\s+to|i'm\s+going\s+to|now\s+i|next,?\s+i)\b/i,
];

// Les trois dernières lignes hors liste : une annonce est suivie au plus de la liste qu'elle
// introduit. Un résumé final (« Résumé : » puis une liste) n'annonce rien et ne relance pas.
export function announcesWork(text: string): boolean {
  const lines = text.trim().slice(-TAIL_CHARS).split("\n").filter((line) => line.trim() && !/^\s*(?:[-*•]|\d+[.)])\s/.test(line));
  return lines.slice(-3).some((line) => ANNOUNCE.some((re) => re.test(line)));
}

function lastAssistant(messages: any[]): any {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]?.role === "assistant") return messages[i];
  return null;
}
const textOf = (m: any) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"));
const callsTools = (m: any) => Array.isArray(m?.content) && m.content.some((c: any) => c.type === "toolCall");

export default function (pi: ExtensionAPI) {
  let usedTools = false;
  let nudges = 0;
  pi.on("agent_start", () => {
    usedTools = false;
    nudges = 0;
  });
  pi.on("tool_execution_end", () => {
    usedTools = true;
  });
  pi.on("agent_before_settle", (event: any) => {
    if (event.outcome !== "completed" || !event.context?.canContinue || !usedTools || nudges >= MAX_NUDGES) return;
    const last = lastAssistant(event.context.llmMessages ?? []);
    if (!last || callsTools(last) || !announcesWork(textOf(last))) return;
    nudges += 1;
    return { entries: [{ type: "custom_message", customType: "follow-through", content: NUDGE, display: false }], continue: true };
  });
}
