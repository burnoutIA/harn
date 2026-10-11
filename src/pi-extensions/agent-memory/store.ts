// Le fichier de mémoire d'un agent : une ligne datée par fait, dans l'ordre où ils ont été notés.
// Le modèle ajoute et retire des lignes entières ; la taille est plafonnée, pour que la mémoire
// ne mange pas le contexte. La personne peut aussi l'éditer à la main depuis Harn.

import { readFileSync, writeFileSync } from "node:fs";

const MAX_FACT_CHARS = 300;

export type Outcome = { ok: boolean; message: string };

export function readMemory(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

export function remember(file: string, maxChars: number, fact: string, today = new Date()): Outcome {
  const text = String(fact ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, message: "Nothing to remember: `fact` is empty." };
  if (text.length > MAX_FACT_CHARS) return { ok: false, message: `Too long (${text.length} characters, ${MAX_FACT_CHARS} at most): keep one short sentence per fact.` };
  const current = readMemory(file);
  if (current.toLowerCase().includes(text.toLowerCase())) return { ok: true, message: "Already in memory." };
  const line = `- ${today.toISOString().slice(0, 10)} : ${text}`;
  const next = current ? `${current}\n${line}` : line;
  if (next.length > maxChars) return { ok: false, message: `Memory is full (${current.length} of ${maxChars} characters). Remove an outdated entry with \`forget\`, then try again.` };
  writeFileSync(file, `${next}\n`);
  return { ok: true, message: "Remembered." };
}

// Une seule ligne à la fois, désignée par un passage de son texte : rien ne part par accident.
export function forget(file: string, match: string): Outcome {
  const needle = String(match ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!needle) return { ok: false, message: "Nothing to forget: `match` is empty." };
  const lines = readMemory(file).split("\n");
  const hits = lines.filter((line) => line.toLowerCase().includes(needle));
  if (!hits.length) return { ok: false, message: "No memory entry contains this text." };
  if (hits.length > 1) return { ok: false, message: `${hits.length} entries contain this text. Quote more of the one to remove:\n${hits.join("\n")}` };
  const next = lines.filter((line) => line !== hits[0]).join("\n").trim();
  writeFileSync(file, next ? `${next}\n` : "");
  return { ok: true, message: `Forgotten: ${hits[0]}` };
}
