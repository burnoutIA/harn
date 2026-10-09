// ctx-optimizer — extension Pi : moins de contexte, sessions plus fiables.
//
//   1. Distillation des vieux résultats d'outils (note vérifiée + lien vers la sortie complète sur disque)
//   2. Retrait du raisonnement des tours passés
//   3. Zone protégée : /goal, outil `note`, messages utilisateur préservés à la compaction
//
// Tout passe par le hook `context` : Pi envoie au modèle une copie allégée, l'historique réel de la session
// n'est jamais modifié. Réglages par variables d'environnement (voir README.md).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyOldResults, distillPrompt, oldResults, stripPastThinking, verifyNote } from "./distill.ts";
import { setupNotes } from "./notes.ts";

const DISTILL_ENTRY = "ctx-optimizer-distill";
const env = (name: string, fallback: string) => process.env[name] ?? fallback;
const CONFIG = {
  distill: env("CTX_OPT_DISTILL", "1") === "1",
  minChars: Number(env("CTX_OPT_MIN_CHARS", "2000")),
  window: Number(env("CTX_OPT_WINDOW", "1")), // tours utilisateur récents laissés intacts
  distillModel: env("CTX_OPT_DISTILL_MODEL", ""), // "provider/model" ; vide = modèle de la session
  stripThinking: env("CTX_OPT_STRIP_THINKING", "1") === "1",
  notes: env("CTX_OPT_NOTES", "1") === "1",
  outDir: env("CTX_OPT_DIR", ".pi/ctx-out"), // relatif au dossier du projet
};

export default function (pi: ExtensionAPI) {
  const notes = CONFIG.notes ? setupNotes(pi) : null;
  const distilled = new Map<string, string | null>(); // clé → note vérifiée, ou null (rejetée / échec : masque + lien)
  const stats = { distilled: 0, rejected: 0, failed: 0 };

  // Les notes distillées sont enregistrées dans la session (non envoyées au modèle) : après un redémarrage,
  // elles sont relues au lieu d'être recalculées, et le contexte envoyé reste identique (cache préservé).
  pi.on("session_start", (_event, ctx: any) => {
    distilled.clear();
    for (const e of ctx.sessionManager.getBranch() as any[]) if (e.type === "custom" && e.customType === DISTILL_ENTRY) distilled.set(e.data.key, e.data.note);
  });

  async function distill(ctx: any, r: ReturnType<typeof oldResults>[number]): Promise<string | null> {
    let model = ctx.model;
    if (CONFIG.distillModel) {
      const [provider, ...rest] = CONFIG.distillModel.split("/");
      model = ctx.modelRegistry.find(provider, rest.join("/")) ?? ctx.model;
    }
    if (!model) return null;
    const p = distillPrompt(r.call, r.text);
    try {
      // streamSimple : options neutres vis-à-vis du fournisseur, dont le niveau de raisonnement (low : les modèles
      // qui raisonnent beaucoup épuiseraient sinon leur budget avant d'écrire la note).
      const res = await ctx.modelRegistry
        .streamSimple(
          model,
          { systemPrompt: p.systemPrompt, messages: [{ role: "user", content: [{ type: "text", text: p.user }], timestamp: Date.now() }] },
          { maxTokens: 1500, reasoning: "low", cacheRetention: "none" },
        )
        .result();
      const note = (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
      if (!note) return (stats.failed++, null);
      const check = verifyNote(note, r.text, r.call);
      if (!check.ok) return (stats.rejected++, null);
      stats.distilled++;
      return note;
    } catch {
      stats.failed++;
      return null;
    }
  }

  pi.on("context", async (event, ctx: any) => {
    let messages = event.messages;

    // Actif en continu dès le début de la session : c'est la configuration mesurée (neutre sur les sessions
    // courtes, −38 à −57 % de coût sur les longues). Un seuil d'activation a été essayé puis retiré : gain marginal.
    if (CONFIG.distill) {
      const targets = oldResults(messages, CONFIG.window, CONFIG.minChars);
      if (targets.length) {
        const dir = join(ctx.cwd, CONFIG.outDir);
        mkdirSync(dir, { recursive: true });
        for (const r of targets) {
          if (distilled.has(r.key)) continue;
          writeFileSync(join(dir, `${r.key}.txt`), r.text); // la sortie complète reste relisible avec read
          const note = await distill(ctx, r);
          distilled.set(r.key, note);
          pi.appendEntry(DISTILL_ENTRY, { key: r.key, note });
        }
        const notesMap = new Map([...distilled].filter(([, v]) => v) as [string, string][]);
        messages = applyOldResults(messages, targets, notesMap, (key) => `${CONFIG.outDir}/${key}.txt`);
      }
    }
    if (CONFIG.stripThinking) messages = stripPastThinking(messages);
    if (notes) messages = notes.inject(messages);

    return messages === event.messages ? undefined : { messages };
  });

  pi.registerCommand("ctx", {
    description: "État de ctx-optimizer : distillations, but, notes",
    handler: async (_args, ctx) => {
      const s = notes?.status();
      const lines = [
        `Distillation : ${CONFIG.distill ? "active" : "désactivée"} — seuil ${CONFIG.minChars} car., fenêtre ${CONFIG.window} tour(s) — ${stats.distilled} notes, ${stats.rejected} rejetées par la vérification, ${stats.failed} échecs`,
        `Raisonnement des tours passés : ${CONFIG.stripThinking ? "retiré" : "conservé"}`,
      ];
      if (s) {
        lines.push(`But : ${s.goal ?? "(aucun)"}`);
        lines.push(`Notes : ${s.notes} · messages préservés après compaction : ${s.preserved}`);
        for (const n of s.list) lines.push(`  [${n.id}] (tour ${n.turn}) ${n.type} — « ${n.quote} »`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
