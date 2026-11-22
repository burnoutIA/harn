// telegram-follow — extension Pi : relie la session en cours à un bot Telegram, dans les deux sens.
//
//   - la réponse finale de chaque run part vers le chat de la personne ;
//   - ses messages reçus par le bot sont injectés dans l'agent ;
//   - ses photos et fichiers sont rangés dans le dossier files/ du workspace, et annoncés à l'agent
//     (une image est aussi montrée au modèle quand il sait voir) ;
//   - l'agent lui montre une image ou lui envoie un fichier (outil send_file) ; une image générée
//     part toute seule ;
//   - « écrit… » reste affiché tant que l'agent travaille ; /new ouvre une nouvelle conversation ;
//   - avec la case Voix de l'agent, /parler fait répondre en messages vocaux (la voix choisie dans Harn),
//     les liens sources à part en texte ; /ecrire revient au texte. Sans la case, rien de tout cela.
//
// Aucun secret ici : le jeton du bot et l'identifiant Telegram de la personne sont lus dans
// telegram.json, que Harn écrit dans le dossier pi de l'agent (data/, hors dépôt). Sans ce fichier,
// l'extension ne fait rien : le pi de test n'écoute aucun bot.
//
// Accès limité à la personne : en privé, son chat seulement ; en groupe, ses messages seulement.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

interface Config {
  token: string;
  ownerId: number;
  agent?: string; // identifiant de l'agent dans Harn
  harn?: string; // adresse de Harn, pour demander la carte
  files?: string; // où ranger les fichiers reçus (le dossier files/ du workspace)
  voice?: boolean; // case Voix cochée : /parler et /ecrire existent
  web?: boolean; // case Recherche web cochée
}

interface Attachment {
  id: string;
  name: string;
  mime: string;
  bytes: number;
}

const DIR = process.env.PI_CODING_AGENT_DIR ?? "";
const LOCK = join(DIR, "telegram.lock");
const NEW_COMMAND = "telegram-new";
const POLL_CLAIM_MS = Number(process.env.HARN_TELEGRAM_CLAIM_MS ?? 2000); // rythme d'attente de la décision
const TYPING_EVERY_MS = 4000; // Telegram éteint « écrit… » au bout de 5 s
const TYPING_MAX_MS = 20 * 60_000; // un run qui ne se termine jamais ne laisse pas le voyant allumé
const MAX_SEND_BYTES = 50 * 1024 * 1024; // ce qu'un bot peut envoyer
const MAX_FILE_BYTES = 20 * 1024 * 1024; // au-delà, Telegram ne laisse pas un bot télécharger le fichier
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

// Ce qu'un message porte en plus de son texte. Une photo arrive en plusieurs tailles : la dernière
// est la plus grande. Les autres pièces jointes ont la même forme (file_id, nom, type, taille).
function attachmentOf(msg: any): Attachment | null {
  if (Array.isArray(msg?.photo) && msg.photo.length) {
    const photo = msg.photo[msg.photo.length - 1];
    return { id: photo.file_id, name: "photo.jpg", mime: "image/jpeg", bytes: photo.file_size ?? 0 };
  }
  for (const kind of ["document", "video", "audio", "voice", "animation", "video_note"]) {
    const file = msg?.[kind];
    if (file?.file_id) return { id: file.file_id, name: file.file_name ?? kind, mime: file.mime_type ?? "", bytes: file.file_size ?? 0 };
  }
  return null;
}

// Un nom de fichier sûr et qui n'écrase rien : daté, sans chemin ni caractère spécial.
function fileName(dir: string, wanted: string, remotePath: string): string {
  const ext = (extname(wanted) || extname(remotePath)).replace(/[^.\w]/g, "").slice(0, 12);
  const stem = basename(wanted, extname(wanted)).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 60) || "fichier";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  for (let n = 1; ; n += 1) {
    const name = `${stamp}-${stem}${n > 1 ? `-${n}` : ""}${ext}`;
    if (!existsSync(join(dir, name))) return name;
  }
}

const megabytes = (bytes: number) => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1000))} Ko` : `${(bytes / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`);

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
// position dans la file du bot, le chat où répondre, et le mode vocal.
const shared = ((globalThis as any).__harnTelegram ??= { offset: 0, chat: 0, voice: false }) as { offset: number; chat: number; voice: boolean };

// --- Mode vocal ---
// Ce que la voix lit d'un coup (MAX_SPEAK_CHARS de voice.mjs) : au-delà, plusieurs messages vocaux.
const SPEAK_CHARS = 1100;
const URL_RE = /https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"»]/g;
// Un chemin de fichier (images/2026…png, /home/…/notes.pdf) : illisible à voix haute, et le fichier
// lui-même est déjà parti dans le chat.
const FILE_RE = /(?:~|\.{1,2})?\/?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,5}\b/g;

// Une réponse à dire, en trois parts : le texte parlé, débarrassé de ce qui ne se lit pas (liens,
// markdown, bloc de code, émojis) ; l'écrit qui suit une ligne « Texte : » (ce que la personne a
// demandé à lire ou garder), envoyé tel quel ; les liens, envoyés à part. « Sources : » ou
// « Liens : » en fin de réponse partent avec eux.
const WRITTEN_RE = /^[ \t]*\**texte\**[ \t]*:\**[ \t]*/im;
const LINKS_RE = /^[ \t]*(?:#+[ \t]*)?\**(?:sources?|liens?)\**[ \t]*:?[ \t]*\**[ \t]*$/im;
export function splitForVoice(text: string): { spoken: string; written: string; links: string[] } {
  let said = text;
  let written = "";
  const mark = WRITTEN_RE.exec(text);
  if (mark) {
    said = text.slice(0, mark.index);
    written = text.slice(mark.index + mark[0].length);
    // Les liens de fin de réponse ne font pas partie de l'écrit.
    const tail = LINKS_RE.exec(written);
    if (tail) {
      said += `\n${written.slice(tail.index)}`;
      written = written.slice(0, tail.index);
    }
    written = written.trim();
  }
  const links = [...new Set(said.match(URL_RE) ?? [])];
  const spoken = said
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(URL_RE, "")
    .replace(FILE_RE, "")
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D\u20E3]/gu, "")
    .replace(/(^|\s)[:;]-?[()DPp](?=\s|$)/g, "$1")
    .split("\n")
    .filter((line) => /[\p{L}\p{N}]/u.test(line) && !/^\s*(?:#+\s*)?\**(?:sources?|liens?)\**\s*:?\**\s*$/i.test(line))
    .join("\n")
    .replace(/[*_`#>|]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ +([.,])/g, "$1")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return { spoken, written, links };
}

// Le texte parlé en morceaux de SPEAK_CHARS au plus, coupés en fin de phrase quand c'est possible.
export function voiceChunks(spoken: string, max = SPEAK_CHARS): string[] {
  const sentences = spoken.replace(/\n+/g, " ").match(/[^.!?…]+[.!?…]+["»]?\s*|[^.!?…]+$/g) ?? [];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    for (let piece = sentence; piece; ) {
      const room = max - current.length;
      if (piece.length <= room) { current += piece; piece = ""; continue; }
      if (current.trim()) { chunks.push(current.trim()); current = ""; continue; }
      const cut = piece.lastIndexOf(" ", max) > 0 ? piece.lastIndexOf(" ", max) : max;
      chunks.push(piece.slice(0, cut).trim());
      piece = piece.slice(cut);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

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

  // Un fichier de l'agent part dans le chat : en photo quand c'en est une (Telegram l'affiche),
  // sinon en document. deliver rend le résultat à qui l'attend ; sendFile, offert aux autres
  // extensions par l'objet partagé (image-gen), prévient la personne en cas d'échec.
  function deliver(file: string, caption = ""): Promise<void> {
    const chat = shared.chat || config!.ownerId;
    const photo = /\.(png|jpe?g|webp)$/i.test(file);
    const sent = sendQueue.then(async () => {
      const form = new FormData();
      form.set("chat_id", String(chat));
      if (caption) form.set("caption", caption.slice(0, 1000));
      form.set(photo ? "photo" : "document", new Blob([readFileSync(file)]), basename(file));
      const res = await fetch(`${api}/${photo ? "sendPhoto" : "sendDocument"}`, { method: "POST", body: form });
      const json: any = await res.json();
      if (!json.ok) throw new Error(json.description);
    });
    sendQueue = sent.catch(() => {});
    return sent;
  }
  function sendFile(file: string, caption = "") {
    deliver(file, caption).catch((error: any) => sendText(shared.chat || config!.ownerId, `Je n'ai pas pu vous envoyer le fichier : ${error.message}.`));
  }
  (shared as any).sendFile = sendFile;

  // Ce que le modèle doit savoir de la situation : la personne n'est pas devant ce terminal. Sans
  // cela, il « montre » une image en la lisant pour lui-même, et elle n'arrive jamais.
  pi.on("before_agent_start", (event: any) => {
    event.systemPromptOptions.sections = {
      ...(event.systemPromptOptions.sections ?? {}),
      telegram:
        "The person talks to you through Telegram, from their phone. They receive only the text of your final reply: they do not see this terminal, your tool calls, or any file on this machine. " +
        "Reading an image with `read` shows it to you, never to them. " +
        "Whenever they ask to see, show, display or receive an image or a file (\"montre-moi l'image\", \"envoie-la\"), call `send_file` with its path, then answer in one short sentence. " +
        "Never say an image is displayed or visible unless `send_file` or `generate_image` has just succeeded.",
      // Un modèle local se croit souvent coupé du monde : sans ce rappel, il répond « je n'ai pas
      // accès à l'actualité » alors que la recherche est là.
      ...(config.web
        ? {
            web:
              `Today is ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}. You have live web access through your web search and page-reading tools. ` +
              "For anything about current events, news, recent facts, prices, schedules, or anything that may have changed since your training, search the web before answering instead of relying on memory. " +
              "Never claim you cannot access current information or the news.",
          }
        : {}),
      ...(config.voice && shared.voice
        ? {
            voice:
              "Voice mode is on: your final reply is read aloud by a French text-to-speech voice and sent as a voice message. " +
              "Write it as natural spoken French, the way you would say it on the phone: short sentences, no markdown, no lists, no tables, no code, no URLs inside the sentences. " +
              "Never use emojis or emoticons: the voice would read them aloud. " +
              "Keep it brief unless asked for detail. " +
              "When they ask for something to read or keep (a text, a letter, a message to send, a poem, a list, a recipe, code), do not read it aloud: " +
              "say one short spoken sentence (that it is done, and ask what they think), then a line \"Texte :\", then the written content exactly as it should appear. It is sent as a text message right after the voice message. " +
              "Every link you want to give (the web sources you used, a page or a video worth opening) goes at the end of the reply, after a line \"Liens :\", one URL per line: they are sent as a separate text message, not read aloud.",
          }
        : {}),
    };
  });

  // L'outil de l'agent pour montrer un fichier à la personne : une image qu'il a faite ou reçue,
  // un document de son dossier de travail. Rien ne sort d'ailleurs que de ce dossier.
  import("typebox").then(({ Type }: any) => {
    pi.registerTool({
      name: "send_file",
      label: "send_file",
      description:
        "Send a file from your working directory to the person on Telegram. Images (png, jpg, webp) are displayed in the chat; other files arrive as documents. " +
        "Images made with generate_image are already sent automatically: use this for any other file, or to show one again.",
      promptSnippet: "send_file: show an image or send a file to the person on Telegram",
      promptGuidelines: [
        "The person reads you on Telegram and cannot open files on this machine: when they ask to see an image or want a file, send it with `send_file` instead of giving its path.",
      ],
      parameters: Type.Object({
        path: Type.String({ description: "Path of the file, inside your working directory" }),
        caption: Type.Optional(Type.String({ description: "Short text shown under the image or file" })),
      }),
      async execute(_id: string, args: any) {
        const answer = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], details: undefined, isError });
        const file = resolve(process.cwd(), String(args.path ?? ""));
        const inside = relative(process.cwd(), file);
        if (!inside || inside.startsWith("..") || isAbsolute(inside)) return answer("Only files inside your working directory can be sent.", true);
        if (!existsSync(file) || !statSync(file).isFile()) return answer(`No such file: ${inside}`, true);
        if (statSync(file).size > MAX_SEND_BYTES) return answer(`File too large for Telegram (${megabytes(statSync(file).size)}, limit ${megabytes(MAX_SEND_BYTES)}).`, true);
        try {
          await deliver(file, typeof args.caption === "string" ? args.caption : "");
          return answer(`Sent to the person on Telegram: ${inside}`);
        } catch (error: any) {
          return answer(`Telegram refused the file: ${error.message}`, true);
        }
      },
    });
  }).catch(() => {});

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
    if (lastTurnText && config.voice && shared.voice) say(chat, lastTurnText);
    else if (lastTurnText) sendText(chat, lastTurnText);
    else if (asked) sendText(chat, "Je n'ai pas pu répondre. Le détail est dans le terminal de l'agent.");
    lastTurnText = "";
    asked = false;
  });

  // La réponse dite : un message vocal par morceau, puis les liens en texte. La voix en panne,
  // la réponse part quand même, écrite.
  async function voiceOf(text: string): Promise<Buffer> {
    const res = await fetch(`${config!.harn}/api/agents/${config!.agent}/voice/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).error ?? `Harn a répondu ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  function say(chat: number, text: string) {
    const { spoken, written, links } = splitForVoice(text);
    const chunks = voiceChunks(spoken);
    sendQueue = sendQueue.then(async () => {
      try {
        for (const chunk of chunks) {
          tg("sendChatAction", { chat_id: chat, action: "record_voice" }).catch(() => {});
          const form = new FormData();
          form.set("chat_id", String(chat));
          form.set("voice", new Blob([await voiceOf(chunk)], { type: "audio/ogg" }), "reponse.ogg");
          const json: any = await (await fetch(`${api}/sendVoice`, { method: "POST", body: form })).json();
          if (!json.ok) throw new Error(json.description);
        }
        for (let i = 0; i < written.length; i += 4000) await tg("sendMessage", { chat_id: chat, text: written.slice(i, i + 4000), disable_web_page_preview: true });
        if (links.length) await tg("sendMessage", { chat_id: chat, text: links.join("\n"), disable_web_page_preview: true });
      } catch (error: any) {
        await tg("sendMessage", { chat_id: chat, text: `(Voix indisponible : ${error.message})\n\n${text}`.slice(0, 4000), disable_web_page_preview: true }).catch(() => {});
      }
    });
  }

  // /parler : Harn démarre la voix (une minute la première fois), puis les réponses sont dites.
  async function startVoice(chat: number) {
    sendText(chat, "Je mets ma voix en route, un instant…");
    try {
      const res = await fetch(`${config!.harn}/api/agents/${config!.agent}/voice/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const report: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(report.error ?? `Harn a répondu ${res.status}`);
      shared.voice = true;
      sendText(chat, "Mode vocal : je vous réponds de vive voix. /ecrire pour revenir au texte.");
    } catch (error: any) {
      sendText(chat, `La voix n'a pas pu démarrer : ${error.message}`);
    }
  }

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

  // --- Fichiers reçus : rangés dans files/, puis annoncés à l'agent avec le texte du message ---
  // Le modèle ne voit une image que s'il sait voir ; sinon il en connaît seulement le chemin.
  let vision = false;
  const sees = (model: any) => Array.isArray(model?.input) && model.input.includes("image");
  pi.on("model_select", (event: any) => {
    vision = sees(event?.model);
  });

  async function receive(file: Attachment, signal: AbortSignal): Promise<{ note: string; image?: { type: "image"; data: string; mimeType: string } }> {
    if (file.bytes > MAX_FILE_BYTES) throw new Error(`il pèse ${megabytes(file.bytes)}, et Telegram ne laisse pas un bot télécharger plus de ${megabytes(MAX_FILE_BYTES)}`);
    const remote = await tg("getFile", { file_id: file.id }, signal);
    const res = await fetch(`https://api.telegram.org/file/bot${config!.token}/${remote.file_path}`, { signal });
    if (!res.ok) throw new Error(`Telegram a répondu ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    const dir = config!.files ?? join(process.cwd(), "files");
    mkdirSync(dir, { recursive: true });
    const saved = join(dir, fileName(dir, file.name, remote.file_path ?? ""));
    writeFileSync(saved, data);
    const shown = relative(process.cwd(), saved);
    const where = shown.startsWith("..") ? saved : shown;
    const image = IMAGE_TYPES.has(file.mime);
    const note = `[Fichier reçu par Telegram, enregistré dans ${where} (${file.mime || "type inconnu"}, ${megabytes(data.length)})${image && !vision ? ". C'est une image, mais le modèle actuel ne sait pas voir : dis-le si on te demande de la regarder" : ""}]`;
    return image && vision ? { note, image: { type: "image", data: data.toString("base64"), mimeType: file.mime } } : { note };
  }

  // Ce que l'agent reçoit : le texte ou la légende, et la pièce jointe s'il y en a une. Un fichier
  // qui ne se télécharge pas n'emporte pas le message avec lui : la personne est prévenue.
  async function contentOf(msg: any, signal: AbortSignal): Promise<string | any[]> {
    const text = String(msg.text ?? msg.caption ?? "").trim();
    const file = attachmentOf(msg);
    if (!file) return text;
    try {
      const { note, image } = await receive(file, signal);
      const full = text ? `${text}\n\n${note}` : note;
      return image ? [{ type: "text", text: full }, image] : full;
    } catch (error: any) {
      if (signal.aborted) throw error;
      sendText(msg.chat.id, `Je n'ai pas pu récupérer votre fichier : ${error.message}.`);
      return text;
    }
  }

  function allowed(msg: any): boolean {
    const text = msg?.text ?? msg?.caption;
    if (!msg?.chat || msg.from?.is_bot || !((typeof text === "string" && text.trim()) || attachmentOf(msg))) return false;
    return msg.chat.type === "private" ? msg.chat.id === config!.ownerId : msg.from?.id === config!.ownerId;
  }

  // --- Entrée : la file du bot, lue en continu tant que la session vit ---
  let stop: AbortController | null = null;
  async function poll(signal: AbortSignal) {
    const commands = [{ command: "new", description: "Nouvelle conversation" }];
    if (config!.voice) commands.push({ command: "parler", description: "Réponses en messages vocaux" }, { command: "ecrire", description: "Réponses écrites" });
    await tg("setMyCommands", { commands }, signal).catch(() => {});
    while (!signal.aborted) {
      try {
        const updates: any[] = await tg("getUpdates", { offset: shared.offset, timeout: 50, allowed_updates: ["message"] }, signal);
        for (const update of updates) {
          shared.offset = update.update_id + 1;
          const msg = update.message;
          if (!allowed(msg)) continue;
          shared.chat = msg.chat.id;
          // En groupe, la commande arrive sous la forme /new@nom_du_bot.
          const command = /^\/(\w+)(?:@\w+)?\s*$/.exec(String(msg.text ?? "").trim())?.[1];
          if (command === "start") {
            sendText(msg.chat.id, "Bonjour. Écrivez-moi ; /new ouvre une nouvelle conversation.");
          } else if (config!.voice && command === "parler") {
            void startVoice(msg.chat.id);
          } else if (config!.voice && command === "ecrire") {
            shared.voice = false;
            sendText(msg.chat.id, "Je reviens à l'écrit. /parler pour reprendre la voix.");
          } else if (command === "new") {
            // La session remplacée coupe cette boucle (session_shutdown) ; la suivante reprend la
            // file après ce /new, la position étant gardée hors de la session.
            pi.sendUserMessage(`/${NEW_COMMAND}`, { expandPromptTemplates: true });
          } else if (running || (await mayUse(msg.chat.id, signal))) {
            startTyping();
            const content = await contentOf(msg, signal);
            if (!content.length) {
              if (!running) stopTyping();
              continue;
            }
            asked = true;
            pi.sendUserMessage(content, { expandPromptTemplates: true, deliverAs: "followUp" });
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
    vision = sees(ctx?.model);
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
