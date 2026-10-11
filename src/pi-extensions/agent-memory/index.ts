// agent-memory — extension Pi : la mémoire d'un agent d'une conversation à l'autre.
//
//   - au début de chaque conversation, le fichier de mémoire est lu et joint au prompt système ;
//   - l'agent y note lui-même ce qu'il juge durable (outil `remember`) et retire ce qui ne vaut
//     plus (outil `forget`).
//
// La mémoire jointe est celle du début de la conversation et ne bouge plus ensuite : le début du
// contexte reste identique d'un tour à l'autre (cache du moteur préservé). Ce qui est noté en
// cours de route est déjà dans la conversation ; il rejoindra le prompt à la suivante.
//
// Le fichier et sa taille maximale viennent de memory.json, que Harn écrit dans le dossier pi de
// l'agent. Sans ce fichier, l'extension ne fait rien : le pi de test n'a pas de mémoire.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { forget, readMemory, remember } from "./store.ts";

function readConfig(): { file: string; maxChars: number } | null {
  try {
    const config = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR ?? "", "memory.json"), "utf8"));
    return typeof config.file === "string" && Number.isInteger(config.maxChars) ? config : null;
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  const config = readConfig();
  if (!config) return;

  let atStart = "";
  pi.on("session_start", () => {
    atStart = readMemory(config.file);
  });
  pi.on("before_agent_start", (event: any) => {
    event.systemPromptOptions.sections = {
      ...(event.systemPromptOptions.sections ?? {}),
      long_term_memory: atStart
        ? `What you noted about this person in earlier conversations (as it was when this conversation started):\n${atStart}`
        : "Your long-term memory is empty: nothing has been noted in earlier conversations yet.",
    };
  });

  const result = (outcome: { ok: boolean; message: string }) => ({ content: [{ type: "text" as const, text: outcome.message }], details: undefined, isError: !outcome.ok });

  pi.registerTool({
    name: "remember",
    label: "remember",
    description:
      "Save one durable fact to your long-term memory, which you will read again at the start of every future conversation with this person. " +
      "One short, self-contained sentence, in the person's language.",
    promptSnippet: "remember: save a durable fact about the person for future conversations",
    promptGuidelines: [
      "Use `remember` for what will still matter in a later conversation: who the person is, their lasting preferences, their ongoing projects, how they want you to work.",
      "Do not `remember` details of the current task, things that will be outdated tomorrow, or anything already in your long-term memory.",
      "When a remembered fact is no longer true, remove it with `forget` and `remember` the new one.",
    ],
    parameters: Type.Object({ fact: Type.String({ description: "One short sentence that stands on its own" }) }),
    async execute(_id: string, args: any) {
      return result(remember(config.file, config.maxChars, args.fact));
    },
  });

  pi.registerTool({
    name: "forget",
    label: "forget",
    description: "Remove one entry from your long-term memory, because it is outdated or wrong. `match` is a passage of that entry's text.",
    promptSnippet: "forget: remove an outdated entry from long-term memory",
    parameters: Type.Object({ match: Type.String({ description: "A passage of the entry to remove, enough to single it out" }) }),
    async execute(_id: string, args: any) {
      return result(forget(config.file, args.match));
    },
  });
}
