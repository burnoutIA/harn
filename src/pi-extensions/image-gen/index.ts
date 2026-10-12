// image-gen — extension Pi : l'agent génère une image avec le modèle d'images installé dans Harn.
//
//   - un outil, `generate_image` : une description, une taille, et au besoin des images à retoucher ;
//   - Harn fait le travail (il prête la carte graphique au modèle d'images, puis la rend au modèle
//     de texte) et range l'image dans le dossier images/ du workspace ;
//   - suivie par Telegram (extension telegram-follow), l'image part aussi dans le chat.
//
// L'adresse de Harn et l'identifiant de l'agent viennent de image.json, que Harn écrit dans le
// dossier pi quand la case Images est cochée. Sans ce fichier, l'extension ne fait rien.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Type } from "typebox";

interface Config {
  harn: string;
  agent: string | null;
}

function readConfig(): Config | null {
  try {
    const config = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR ?? "", "image.json"), "utf8"));
    return typeof config.harn === "string" ? config : null;
  } catch {
    return null;
  }
}

const sees = (model: any) => Array.isArray(model?.input) && model.input.includes("image");

export default function (pi: ExtensionAPI) {
  const config = readConfig();
  if (!config) return;

  // Les modèles installés, lus à chaque conversation : la description de l'outil les nomme.
  let models: { id: string; name: string; tagline: string }[] = [];
  let vision = false;
  async function refresh() {
    try {
      const report: any = await (await fetch(`${config!.harn}/api/images`)).json();
      models = (report.models ?? []).filter((model: any) => model.installed);
    } catch {
      models = [];
    }
  }
  pi.on("session_start", async (_event, ctx: any) => {
    vision = sees(ctx?.model);
    await refresh();
  });
  pi.on("model_select", (event: any) => {
    vision = sees(event?.model);
  });
  pi.on("before_agent_start", (event: any) => {
    event.systemPromptOptions.sections = {
      ...(event.systemPromptOptions.sections ?? {}),
      image_generation: models.length
        ? `You can create images with \`generate_image\`. Image models installed on this machine: ${models.map((m) => `${m.id} (${m.name}: ${m.tagline})`).join("; ")}.`
        : "`generate_image` is available, but no image model is installed yet: the user installs one in Harn (Modèles view).",
    };
  });

  pi.registerTool({
    name: "generate_image",
    label: "generate_image",
    description:
      "Create an image from a description, or edit existing images, with the image model installed on this machine. " +
      "The image is saved in the images/ folder of your working directory and shown to the person. " +
      "Takes from a few seconds to a few minutes: the graphics card is lent to the image model, then given back to you.",
    promptSnippet: "generate_image: create or edit an image on this machine",
    promptGuidelines: [
      "Write the `prompt` for `generate_image` in English, as one detailed description: subject, setting, style, light, framing. Text to render in the image goes between quotes.",
      "To edit an image the person sent or you generated, pass its path in `references` and describe the change in `prompt`.",
      "After `generate_image`, say in one sentence what you made; do not describe the file path at length.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Detailed description of the image, in English" }),
      width: Type.Optional(Type.Integer({ description: "Width in pixels, 256 to 2048 (default 1024)" })),
      height: Type.Optional(Type.Integer({ description: "Height in pixels, 256 to 2048 (default 1024)" })),
      model: Type.Optional(Type.String({ description: "Id of an installed image model; omit for the default one" })),
      references: Type.Optional(Type.Array(Type.String(), { description: "Paths, inside your working directory, of images to edit or to take as reference" })),
      negative: Type.Optional(Type.String({ description: "What the image must not contain" })),
      seed: Type.Optional(Type.Integer({ description: "Same seed and prompt give the same image; omit for a new one each time" })),
    }),
    async execute(_id: string, args: any, signal?: AbortSignal) {
      try {
        const res = await fetch(`${config.harn}/api/images/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...args, agent: config.agent }), signal });
        const made: any = await res.json();
        if (!res.ok) return { content: [{ type: "text" as const, text: made.error ?? `Harn a répondu ${res.status}` }], details: undefined, isError: true };
        const shown = relative(process.cwd(), made.file);
        const where = shown.startsWith("..") ? made.file : shown;
        // Le chat Telegram de la personne, quand l'agent en a un.
        (globalThis as any).__harnTelegram?.sendFile?.(made.file);
        const text = `Image saved to ${where} (${made.width}x${made.height}, model ${made.model}, seed ${made.seed}, ${made.seconds} s). The person can see it.`;
        const image = vision ? [{ type: "image" as const, data: readFileSync(made.file).toString("base64"), mimeType: "image/png" }] : [];
        return { content: [{ type: "text" as const, text }, ...image], details: undefined, isError: false };
      } catch (error: any) {
        return { content: [{ type: "text" as const, text: `Image non générée : ${error.message}` }], details: undefined, isError: true };
      }
    },
  });
}
