// Zone protégée : /goal + notes de l'agent + messages utilisateur préservés à la compaction.
// Rien de tout cela ne vit dans l'historique : ni la compaction ni la distillation ne peuvent l'altérer.
//
// Principe (issu des tests) : le modèle AJOUTE, une règle mécanique PROTÈGE, personne ne SUPPRIME.
//   - /goal : gardé mot pour mot, ne change que si l'utilisateur refait /goal ;
//   - outil `note` : l'agent enregistre buts, règles et décisions en citant l'utilisateur ; ajout seul,
//     en cas de conflit la note la plus récente fait foi (aucune suppression par jugement du modèle) ;
//   - compaction : les messages de l'utilisateur de la partie résumée sont gardés mot pour mot (sans LLM).
// Placement : but + messages préservés en tête (changent rarement → restent en cache), notes en fin (lues en dernier).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Note = { id: number; type: string; quote: string; turn: number };

const STATE_ENTRY = "ctx-optimizer-state";
const MAX_PRESERVED_CHARS = 1500; // un long collage (log, code) n'est pas une consigne : on en garde le début

const textOf = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((b: any) => b.text ?? "").join("\n"));

export function setupNotes(pi: ExtensionAPI) {
  let goal: string | null = null;
  const notes: Note[] = [];
  const preserved: string[] = [];
  let turn = 0;

  pi.on("before_agent_start", (_event, ctx: any) => {
    turn++;
    // Pi ne crée le fichier de session qu'au premier message : un /goal tapé avant est enregistré dans le vide.
    // Si l'état n'est pas encore dans la session, on le réenregistre maintenant.
    const saved = (ctx.sessionManager.getBranch() as any[]).some((e) => e.type === "custom" && e.customType === STATE_ENTRY);
    if (!saved && (goal || notes.length || preserved.length)) save();
  });

  // Persistance : un instantané de l'état est ajouté à la session à chaque changement (non envoyé au modèle),
  // et relu au démarrage / à la reprise (pi -c, /resume). Sans cela, but et notes seraient perdus au redémarrage.
  const save = () => pi.appendEntry(STATE_ENTRY, { goal, notes, preserved });
  pi.on("session_start", (_event, ctx: any) => {
    const branch = ctx.sessionManager.getBranch() as any[];
    const last = [...branch].reverse().find((e) => e.type === "custom" && e.customType === STATE_ENTRY);
    goal = last?.data?.goal ?? null;
    notes.splice(0, notes.length, ...(last?.data?.notes ?? []));
    preserved.splice(0, preserved.length, ...(last?.data?.preserved ?? []));
    turn = branch.filter((e) => e.type === "message" && e.message?.role === "user").length;
  });

  pi.registerCommand("goal", {
    description: "Fixe le but de la session (gardé mot pour mot, jamais résumé). /goal sans texte : affiche le but ; /goal clear : l'efface",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) return ctx.ui.notify(goal ? `But : ${goal}` : "Aucun but défini.", "info");
      goal = text === "clear" ? null : text;
      save();
      ctx.ui.notify(goal ? "But enregistré." : "But effacé.", "info");
    },
  });

  pi.registerTool({
    name: "note",
    label: "note",
    description:
      "Record a session note that will never be summarized or forgotten: the user's goal, a rule/constraint, or a decision that will matter later. " +
      "`quote` must be the user's EXACT words (same language), copied from the user's message, never a paraphrase or your own conclusion.",
    promptSnippet: "note: record a goal, rule or decision stated by the user (exact quote) so it is never lost",
    promptGuidelines: [
      "When the user states a goal, a rule or constraint, or a decision that will matter later in the session, record it immediately with the `note` tool, copying the user's exact words.",
      "Decisions are often hidden inside a work request: record them too. Watch for changes of plan (\"finally\", \"instead\", \"from now on\", \"no longer\", \"finalement\", \"non plus\", \"plutôt\") and for constraints attached to a task (\"without …\", \"only …\", \"never …\", \"sans …\", \"uniquement …\", \"jamais …\").",
      "When the user changes an earlier decision, just record the new one: notes are dated by turn and the most recent one wins.",
      "Only note what the user said: not questions, not your own findings or actions, not a copy of the /goal.",
      "Session notes are shown to you at the end of the context on every turn; they take precedence over summaries.",
    ],
    parameters: Type.Object({
      type: Type.Union([Type.Literal("GOAL"), Type.Literal("RULE"), Type.Literal("DECISION")]),
      quote: Type.String({ description: "The user's exact words" }),
    }),
    async execute(_id: string, args: any) {
      const note: Note = { id: notes.length + 1, type: args.type, quote: args.quote, turn };
      notes.push(note);
      save();
      return { content: [{ type: "text" as const, text: `Note [${note.id}] recorded.` }], details: undefined };
    },
  });

  // Avant chaque compaction : les messages de l'utilisateur qui vont être résumés sont gardés mot pour mot.
  pi.on("session_before_compact", (event: any) => {
    const userMsgs = (event.preparation?.messagesToSummarize ?? [])
      .filter((m: any) => m.role === "user")
      .map(textOf)
      .filter((t: string) => t && !t.startsWith("The conversation history before this point was compacted"))
      .map((t: string) => (t.length > MAX_PRESERVED_CHARS ? t.slice(0, MAX_PRESERVED_CHARS) + " […]" : t));
    preserved.push(...userMsgs);
    if (userMsgs.length) save();
  });

  function inject(messages: any[]): any[] {
    const head: any[] = [];
    if (goal) head.push({ role: "user", content: `[Session goal, set by the user with /goal — verbatim]\n${goal}`, timestamp: 0 });
    if (preserved.length)
      head.push({
        role: "user",
        content: `[User messages from before the compaction — verbatim, in order]\n${preserved.map((t, i) => `(${i + 1}) ${t}`).join("\n")}`,
        timestamp: 0,
      });
    const out = [...head, ...messages];
    if (notes.length)
      out.push({
        role: "user",
        content: [
          "[Session notes — automatic reminder, not a new user message. They take precedence over any summary; if two notes conflict, the most recent wins. Apply each rule as written, without extending it.]",
          ...notes.map((n) => `[${n.id}] (turn ${n.turn}) ${n.type} — « ${n.quote} »`),
        ].join("\n"),
        timestamp: Number.MAX_SAFE_INTEGER,
      });
    return out;
  }

  const status = () => ({ goal, notes: notes.length, preserved: preserved.length, list: notes });
  return { inject, status };
}
