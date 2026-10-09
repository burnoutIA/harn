// Distillation des vieux résultats d'outils.
//
// Un résultat d'outil volumineux (log, fichier, sortie de commande) qui sort de la fenêtre récente est remplacé,
// UNE SEULE FOIS, par une note de 1 à 3 lignes + un lien vers la sortie complète enregistrée sur le disque.
// La note ne change plus ensuite : elle ne casse pas le cache de prompt.
//
// Garde-fous (issus des tests) :
//   - seules les sorties de plus de `minChars` caractères sont distillées (une petite sortie n'apporte rien à résumer
//     et le risque d'invention est réel) ;
//   - vérification mécanique : tout nombre cité par la note doit figurer dans la source, sinon la note est rejetée
//     et le résultat est simplement masqué avec le lien (un modèle a « distillé » 3 lignes en « 15 entrées »).

type Msg = any;

export interface OldResult {
  index: number;
  text: string;
  key: string;
  call?: { name: string; args: any };
}

export function hashKey(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

const textOf = (m: Msg) => (Array.isArray(m.content) ? m.content.map((b: any) => b.text ?? "").join("\n") : String(m.content ?? ""));

// Résultats d'outils hors des `window` derniers tours utilisateur, et assez gros pour être distillés.
export function oldResults(messages: Msg[], window: number, minChars: number): OldResult[] {
  const userIdx = messages.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
  const keepFrom = userIdx.length > window ? userIdx[userIdx.length - window] : 0;
  const calls = new Map<string, { name: string; args: any }>();
  for (const m of messages) if (m.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "toolCall") calls.set(b.id, { name: b.name, args: b.arguments });
  const out: OldResult[] = [];
  messages.forEach((m, i) => {
    if (i >= keepFrom || m.role !== "toolResult") return;
    const text = textOf(m);
    if (text.length < minChars) return;
    out.push({ index: i, text, key: hashKey(text), call: calls.get(m.toolCallId) });
  });
  return out;
}

// Demande de distillation (format de message Pi). Très longue sortie : début + fin + lignes significatives du milieu.
export function distillPrompt(call: OldResult["call"], text: string) {
  let body = text;
  if (text.length > 12000) {
    const middle = text.slice(5000, -5000).split("\n").filter((l) => /error|fail|✖|exception|warn|assert|denied|not set|no such/i.test(l)).slice(0, 40);
    body = text.slice(0, 5000) + `\n[… middle omitted, significant lines kept:]\n${middle.join("\n")}\n[…]\n` + text.slice(-5000);
  }
  return {
    systemPrompt:
      "You compress tool outputs for a coding agent's context. Write 1 to 3 short factual lines, in the language of the conversation: " +
      "what this output contains that could matter later — errors with file, line and cause, failing test names, key values, conclusions. " +
      "Keep exact file paths, identifiers, numbers and error messages. Never invent or compute numbers that are not in the output. " +
      // Une sortie qui concatène plusieurs fichiers a été résumée comme un seul « log de build » : le README avait disparu.
      "If the output combines several files or commands, write one line per file or command, naming it, so none is lost. No prose, no advice.",
    user: `Tool call: ${call ? `${call.name}(${JSON.stringify(call.args)})` : "(unknown)"}\n\nOutput:\n${body}`,
  };
}

// Vérification mécanique : chaque nombre cité dans la note doit apparaître dans la source (ou dans l'appel d'outil).
export function verifyNote(note: string, source: string, call?: OldResult["call"]): { ok: boolean; unknown: string[] } {
  const norm = (s: string) => s.replace(/(\d),(\d)/g, "$1.$2");
  const known = new Set(norm(source + "\n" + JSON.stringify(call?.args ?? {})).match(/\d+(?:\.\d+)?/g) ?? []);
  const cited = norm(note).match(/\d+(?:\.\d+)?/g) ?? [];
  const unknown = [...new Set(cited.filter((n) => !known.has(n)))];
  return { ok: unknown.length === 0, unknown };
}

// Remplace les vieux résultats : note vérifiée + lien, ou masque + lien si la note est absente ou rejetée.
// `linkFor(key)` donne le chemin (relatif au projet) où la sortie complète a été enregistrée.
export function applyOldResults(messages: Msg[], targets: OldResult[], notes: Map<string, string>, linkFor: (key: string) => string) {
  const byIndex = new Map(targets.map((r) => [r.index, r]));
  return messages.map((m, i) => {
    const r = byIndex.get(i);
    if (!r) return m;
    // Nommer l'appel d'origine : sans cela, un modèle a cru que le marqueur décrivait un autre fichier.
    const a = r.call?.args ?? {};
    const origin = r.call ? `${r.call.name}(${String(a.path ?? a.file_path ?? a.command ?? a.pattern ?? "").slice(0, 80)})` : "a tool call";
    const link = `original output of ${origin} saved to ${linkFor(r.key)} (${r.text.length} chars) — use read on that path to see it`;
    const note = notes.get(r.key);
    const body = note
      ? `[ctx-optimizer: condensed result of ${origin}]\n${note}\n[${link}]`
      : `[ctx-optimizer: old result of ${origin} hidden — ${link}]`;
    return { ...m, content: [{ type: "text", text: body }] };
  });
}

// Retire le raisonnement (blocs thinking) des tours passés : ~1/3 du contexte brut, inutile une fois le tour terminé.
// Le tour en cours (après le dernier message utilisateur) n'est jamais touché.
export function stripPastThinking(messages: Msg[]): Msg[] {
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { last = i; break; }
  if (last < 0) return messages;
  return messages.map((m, i) => {
    if (i >= last || m.role !== "assistant" || !Array.isArray(m.content)) return m;
    const content = m.content.filter((b: any) => b.type !== "thinking");
    return content.length === m.content.length ? m : { ...m, content };
  });
}
