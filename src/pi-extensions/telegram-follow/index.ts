// telegram-follow — extension Pi : relie la session en cours à un bot Telegram, dans les deux sens.
//
//   - la réponse finale de chaque run part vers le chat de la personne ;
//   - ses messages reçus par le bot sont injectés dans l'agent ;
//   - « écrit… » reste affiché tant que l'agent travaille ; /new ouvre une nouvelle conversation.
//
// Aucun secret ici : le jeton du bot et l'identifiant Telegram de la personne sont lus dans
// telegram.json, que Harn écrit dans le dossier pi de l'agent (data/, hors dépôt). Sans ce fichier,
// l'extension ne fait rien : le pi de test n'écoute aucun bot.
//
// Accès limité à la personne : en privé, son chat seulement ; en groupe, ses messages seulement.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Config {
  token: string;
  ownerId: number;
  agent?: string; // identifiant de l'agent dans Harn
  harn?: string; // adresse de Harn, pour demander la carte
}

const DIR = process.env.PI_CODING_AGENT_DIR ?? "";
const LOCK = join(DIR, "telegram.lock");
const NEW_COMMAND = "telegram-new";
const POLL_CLAIM_MS = Number(process.env.HARN_TELEGRAM_CLAIM_MS ?? 2000); // rythme d'attente de la décision
const TYPING_EVERY_MS = 4000; // Telegram éteint « écrit… » au bout de 5 s
const TYPING_MAX_MS = 20 * 60_000; // un run qui ne se termine jamais ne laisse pas le voyant allumé

function readConfig(): Config | null {
  try {
    const config = JSON.parse(readFileSync(join(DIR, "telegram.json"), "utf8"));
    return typeof config.token === "string" && Number.isInteger(config.ownerId) ? config : null;
  } catch {
    return null;
  }
}

// Un bot n'a qu'un lecteur : un second pi lancé sur le même agent n'écoute pas. Le verrou porte
// le pid du premier ; celui d'un pi disparu ne compte pas.
function takeLock(): boolean {
  try {
    const pid = Number(readFileSync(LOCK, "utf8"));
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        return false;
      } catch {}
    }
  } catch {}
  writeFileSync(LOCK, String(process.pid));
  return true;
}
function releaseLock() {
  try {
    if (Number(readFileSync(LOCK, "utf8")) === process.pid) rmSync(LOCK, { force: true });
  } catch {}
}

// Ce qui survit au remplacement de session (/new recharge l'extension, pas le processus) : la
// position dans la file du bot et le chat où répondre.
const shared = ((globalThis as any).__harnTelegram ??= { offset: 0, chat: 0 }) as { offset: number; chat: number };

function assistantText(m: any): string {
  if (m?.role !== "assistant") return "";
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content.filter((c: any) => c.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n");
}

export default function (pi: ExtensionAPI) {
  const config = DIR && existsSync(DIR) ? readConfig() : null;
  if (!config) return;
  const api = `https://api.telegram.org/bot${config.token}`;

  async function tg(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const res = await fetch(`${api}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params), signal });
    const json: any = await res.json();
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
    return json.result;
  }

  // Envois à la suite, pour garder l'ordre ; un message Telegram ne dépasse pas 4096 caractères.
  let sendQueue: Promise<unknown> = Promise.resolve();
  function sendText(chat: number, text: string) {
    for (let i = 0; i < text.length; i += 4000) {
      const part = text.slice(i, i + 4000);
      sendQueue = sendQueue.then(() => tg("sendMessage", { chat_id: chat, text: part, disable_web_page_preview: true }).catch(() => {}));
    }
  }

  // --- Voyant « écrit… » ---
  let typing: ReturnType<typeof setInterval> | null = null;
  function stopTyping() {
    if (typing) clearInterval(typing);
    typing = null;
  }
  function startTyping() {
    if (typing) return;
    const chat = shared.chat || config!.ownerId;
    const since = Date.now();
    const beat = () => {
      if (Date.now() - since > TYPING_MAX_MS) return stopTyping();
      tg("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
    };
    beat();
    typing = setInterval(beat, TYPING_EVERY_MS);
  }

  // --- Sortie : la dernière réponse de chaque run terminé ---
  let lastTurnText = "";
  let asked = false; // le run en cours vient d'un message Telegram : il lui faut une réponse
  let running = false; // l'agent travaille déjà : la carte est à lui
  pi.on("agent_start", () => {
    running = true;
    startTyping();
  });
  pi.on("turn_end", (event: any) => {
    const text = assistantText(event?.message);
    if (text) lastTurnText = text;
  });
  pi.on("agent_settled", () => {
    running = false;
    stopTyping();
    const chat = shared.chat || config.ownerId;
    if (lastTurnText) sendText(chat, lastTurnText);
    else if (asked) sendText(chat, "Je n'ai pas pu répondre. Le détail est dans le terminal de l'agent.");
    lastTurnText = "";
    asked = false;
  });

  // --- /new : seule une commande peut remplacer la session ---
  pi.registerCommand(NEW_COMMAND, {
    description: "Nouvelle conversation (demandée depuis Telegram)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const chat = shared.chat || config.ownerId;
      const result = await ctx.newSession();
      sendText(chat, result.cancelled ? "La conversation en cours n'a pas pu être fermée." : "Nouvelle conversation.");
    },
  });

  // --- La carte : demandée à Harn avant d'injecter un message ---
  // Libre, Harn répond tout de suite. Occupée par quelqu'un d'autre, il pose la question dans sa
  // fenêtre : on prévient la personne et on attend la décision (au plus une minute côté Harn).
  // Harn injoignable ou trop ancien : le message passe, comme avant.
  async function mayUse(chat: number, signal: AbortSignal): Promise<boolean> {
    if (!config!.harn || !config!.agent) return true;
    try {
      const claim: any = await (await fetch(`${config!.harn}/api/agents/${config!.agent}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal })).json();
      if (claim.status !== "pending") return true;
      sendText(chat, "L'IA est occupée par quelqu'un d'autre. Je préviens, un instant…");
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_CLAIM_MS));
        if (signal.aborted) return false;
        const approval: any = await (await fetch(`${config!.harn}/api/approvals/${claim.approval}`, { signal })).json();
        if (approval.status === "pending") continue;
        return approval.status !== "refused";
      }
    } catch {
      return !signal.aborted;
    }
  }

  function allowed(msg: any): boolean {
    if (!msg?.chat || typeof msg.text !== "string" || !msg.text.trim() || msg.from?.is_bot) return false;
    return msg.chat.type === "private" ? msg.chat.id === config!.ownerId : msg.from?.id === config!.ownerId;
  }

  // --- Entrée : la file du bot, lue en continu tant que la session vit ---
  let stop: AbortController | null = null;
  async function poll(signal: AbortSignal) {
    await tg("setMyCommands", { commands: [{ command: "new", description: "Nouvelle conversation" }] }, signal).catch(() => {});
    while (!signal.aborted) {
      try {
        const updates: any[] = await tg("getUpdates", { offset: shared.offset, timeout: 50, allowed_updates: ["message"] }, signal);
        for (const update of updates) {
          shared.offset = update.update_id + 1;
          const msg = update.message;
          if (!allowed(msg)) continue;
          shared.chat = msg.chat.id;
          // En groupe, la commande arrive sous la forme /new@nom_du_bot.
          const command = /^\/(\w+)(?:@\w+)?\s*$/.exec(msg.text.trim())?.[1];
          if (command === "start") {
            sendText(msg.chat.id, "Bonjour. Écrivez-moi ; /new ouvre une nouvelle conversation.");
          } else if (command === "new") {
            // La session remplacée coupe cette boucle (session_shutdown) ; la suivante reprend la
            // file après ce /new, la position étant gardée hors de la session.
            pi.sendUserMessage(`/${NEW_COMMAND}`, { expandPromptTemplates: true });
          } else if (running || (await mayUse(msg.chat.id, signal))) {
            asked = true;
            startTyping();
            pi.sendUserMessage(msg.text.trim(), { expandPromptTemplates: true, deliverAs: "followUp" });
          } else if (!signal.aborted) {
            sendText(msg.chat.id, "Ce n'est pas possible pour l'instant. Réessayez un peu plus tard.");
          }
        }
      } catch {
        if (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  pi.on("session_start", (_event, ctx: any) => {
    if (stop) return;
    if (!takeLock()) return ctx.ui.notify("Telegram : ce bot est déjà suivi par un autre pi de cet agent.", "warning");
    stop = new AbortController();
    void poll(stop.signal);
  });
  pi.on("session_shutdown", () => {
    stop?.abort();
    stop = null;
    stopTyping();
    releaseLock();
  });
}
