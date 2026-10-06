import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { displayName, modelById } from './catalog.mjs';
import { PORTS, fromRoot } from './paths.mjs';
import { OBJECTIVE } from './planner.mjs';
import { getState } from './state.mjs';

// Le carnet de la machine : docs/machines/<machine>.md. Trois parties, chacune a son auteur :
// - les mesures, réécrites par l'application après chaque banc (entre marqueurs) ;
// - l'analyse, rédigée par l'IA locale à partir des mesures et de docs/leviers-inference.md ;
// - les notes libres, ajoutées au fil de l'usage (par pi agent ou par une personne).
// L'application ne touche jamais aux notes libres.

export const LEVERS_DOC = fromRoot('docs', 'leviers-inference.md');
const MARK = (name) => [`<!-- harn:${name}:début -->`, `<!-- harn:${name}:fin -->`];

const slugify = (text) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/nvidia|geforce|amd|radeon|\(r\)|\(tm\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function machineDocPath(hardware) {
  const gpu = hardware.primary ? slugify(hardware.primary.name) : 'cpu';
  return fromRoot('docs', 'machines', `${gpu}-${Math.round(hardware.ramGiB)}go-ram.md`);
}

function replaceBlock(text, name, body) {
  const [open, close] = MARK(name);
  const block = `${open}\n${body.trim()}\n${close}`;
  const start = text.indexOf(open);
  const end = text.indexOf(close);
  if (start >= 0 && end > start) return text.slice(0, start) + block + text.slice(end + close.length);
  return null;
}

function skeleton(hardware) {
  const gpu = hardware.primary;
  const [mOpen, mClose] = MARK('mesures');
  const [aOpen, aClose] = MARK('analyse');
  return `# ${gpu?.name ?? 'Processeur seul'} · ${Math.round(hardware.ramGiB)} Go de RAM

Carnet de cette machine. Les mesures sont réécrites par Harn après chaque banc ; l'analyse
est rédigée par l'IA locale ; les notes en bas s'accumulent au fil de l'usage. Référence
générale : [leviers d'inférence](../leviers-inference.md).

${mOpen}
${mClose}

${aOpen}
${aClose}

## Notes au fil de l'usage

Ajouter ici, avec la date, toute observation mesurée sur cette machine (réglage essayé,
débit constaté, problème rencontré). Une note par entrée, la plus récente en haut.
`;
}

const fr = (value, digits = 0) => (value === null || value === undefined ? '—' : Number(value).toLocaleString('fr-FR', { maximumFractionDigits: digits }));

export function factsMarkdown(state) {
  const { hardware, plan } = state;
  const gpu = hardware.primary;
  const lines = [];
  lines.push(`## Mesures (Harn, ${new Date().toLocaleString('fr-FR')})`, '');
  lines.push('| Élément | Valeur |', '|---|---|');
  lines.push(`| Carte | ${gpu ? `${gpu.name}, ${hardware.vramGiB} Go, pilote ${gpu.driver ?? '?'}, CUDA ${gpu.cuda ?? '—'}` : 'aucune'} |`);
  lines.push(`| Architecture | ${plan.summary.arch}, ~${plan.summary.bandwidth} Go/s de bande passante |`);
  lines.push(`| Processeur | ${hardware.cpu.model}, ${hardware.cpu.physical} cœurs |`);
  lines.push(`| RAM | ${Math.round(hardware.ramGiB)} Go |`);
  lines.push(`| VRAM prise par le reste du système | ${hardware.vramBaselineMiB ? `${fr(hardware.vramBaselineMiB / 1024, 1)} Go` : '—'} |`);
  lines.push(`| Moteur | ${plan.backend.label} |`, '');

  lines.push(`### Objectif : ${OBJECTIVE.minContext / 1024}k-${OBJECTIVE.maxContext / 1024}k de contexte, ${OBJECTIVE.minTps} tok/s minimum`, '');
  lines.push('| Modèle | Intelligence /100 (banc Harn) | Verdict | Contexte | KV | Débit estimé à 100k | Mesuré ici |', '|---|---|---|---|---|---|---|');
  for (const verdict of plan.verdicts) {
    const model = modelById(verdict.id);
    const bench = state.profiles[verdict.id]?.bench?.winner;
    const role = verdict.id === plan.targetModel ? '**visé**' : verdict.role === 'first' ? 'installé d’abord' : verdict.fit === 'no' ? 'hors de portée' : 'compatible';
    lines.push(`| ${displayName(model)} | ${verdict.tested ? verdict.intelligence : `~${model.quality ?? '?'} (estimée)`} | ${role} | ${verdict.context ? `${Math.round(verdict.context / 1024)}k` : '—'} | ${verdict.kv ?? '—'} | ${verdict.tps ? `~${verdict.tps}` : '—'} | ${bench ? `${fr(bench.tps)} tok/s` : '—'} |`);
  }
  if (plan.advice) lines.push('', `> ${plan.advice}`);

  for (const [id, profile] of Object.entries(state.profiles)) {
    if (!profile.bench) continue;
    const model = modelById(id);
    lines.push('', `### Banc : ${displayName(model)} (${new Date(profile.bench.at).toLocaleString('fr-FR')})`, '');
    lines.push('| Levier | Variante | Code | Texte | Contexte long | Score | VRAM libre | Retenu |', '|---|---|---|---|---|---|---|---|');
    for (const arm of profile.bench.arms) {
      const w = (name) => arm.workloads?.find((x) => x.workload === name)?.tps;
      if (arm.error) { lines.push(`| ${arm.stage ?? ''} | ${arm.label} | échec : ${arm.error.replace(/\|/g, '/').slice(0, 80)} | | | | | |`); continue; }
      lines.push(`| ${arm.stage ?? ''} | ${arm.label} | ${fr(w('code'))} | ${fr(w('prose'))} | ${fr(w('deep'))} | ${fr(arm.tps, 1)} | ${arm.headroomMiB ? `${fr(arm.headroomMiB / 1024, 1)} Go` : '—'} | ${arm.id === profile.bench.winner.id ? 'oui' : arm.ok === false ? 'écarté (marge)' : ''} |`);
    }
    const pstates = [...new Set(profile.bench.arms.flatMap((arm) => arm.pstates ?? []))];
    lines.push('', `Protocole : glouton (température 0), graine 42, sortie fixe de 384 tokens, un échauffement par variante, compteurs du moteur. Charges : code (~3 900 tokens de prompt), texte (prompt court), contexte long (~20 000 tokens, seulement quand le type de KV est comparé). États P relevés pendant la génération : ${pstates.length ? pstates.join(', ') : 'non relevés'}.`);
    if (profile.bench.winner.throttled) lines.push('', '> La carte est passée en économie d’énergie (P3+) pendant la mesure : chiffres sous-évalués.');
    if (profile.usage?.seconds) lines.push('', `Usage réel : ${profile.usage.requests} requêtes, ${fr(profile.usage.tokens / profile.usage.seconds)} tok/s en moyenne.`);
  }
  return lines.join('\n');
}

export async function writeMachineFacts() {
  const state = getState();
  if (!state.hardware || !state.plan) return null;
  const file = machineDocPath(state.hardware);
  await mkdir(path.dirname(file), { recursive: true });
  let text = await readFile(file, 'utf8').catch(() => skeleton(state.hardware));
  text = replaceBlock(text, 'mesures', factsMarkdown(state)) ?? `${text}\n\n${MARK('mesures')[0]}\n${factsMarkdown(state)}\n${MARK('mesures')[1]}\n`;
  await writeFile(file, text);
  return file;
}

// L'IA locale lit la référence et les mesures, puis rédige son analyse. Elle passe par notre
// propre endpoint : la requête apparaît dans le direct comme n'importe quelle autre.
export async function askLocalAnalysis() {
  const state = getState();
  const modelId = state.active?.modelId;
  if (!modelId || state.active.status !== 'ready') return null;
  const file = await writeMachineFacts();
  const levers = await readFile(LEVERS_DOC, 'utf8');
  const facts = factsMarkdown(state);
  const response = await fetch(`http://127.0.0.1:${PORTS.app}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'harn-analyse' },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 6000,
      reasoning_effort: 'medium',
      messages: [
        {
          role: 'system',
          content: `Tu es l'IA locale de cette machine, servie par Harn. Voici la référence des leviers d'inférence :\n\n${levers}`,
        },
        {
          role: 'user',
          content: `Voici les mesures réelles de cette machine :\n\n${facts}\n\nRédige en français, en Markdown, une section qui commence par « ## Analyse de l'IA locale ». Contenu :\n1. En trois phrases : où en est la machine par rapport à l'objectif (contexte, intelligence, vitesse).\n2. Ce que les mesures disent des leviers (cite les chiffres du tableau ; ne répète pas la référence).\n3. Au plus cinq pistes à tester, chacune ne change qu'une variable, avec le gain attendu et comment le mesurer.\n4. Ce qui pourrait fausser ces mesures sur cette machine.\nN'invente aucun chiffre : si une donnée manque, dis-le. Pas d'introduction ni de conclusion.`,
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Analyse : HTTP ${response.status}`);
  const answer = await response.json();
  const content = answer.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Analyse vide (budget de sortie épuisé pendant la réflexion ?)');
  const model = modelById(modelId);
  const body = `${content.replace(/^#+\s*Analyse de l'IA locale\s*\n/i, "## Analyse de l'IA locale\n")}\n\n*Rédigé par ${displayName(model)} le ${new Date().toLocaleString('fr-FR')}, à partir des mesures ci-dessus.*`;
  let text = await readFile(file, 'utf8');
  text = replaceBlock(text, 'analyse', body) ?? `${text}\n\n${MARK('analyse')[0]}\n${body}\n${MARK('analyse')[1]}\n`;
  await writeFile(file, text);
  return file;
}

// Les consignes que pi lit au démarrage : où est la référence, où est le carnet, et comment y
// contribuer sans écraser ce que Harn maintient.
export function agentInstructions(hardware) {
  const machine = machineDocPath(hardware);
  return `# Contexte : IA locale servie par Harn

Tu tournes entièrement sur cette machine, servi par Harn (endpoint OpenAI local). Ton débit
et ta mémoire dépendent de la carte graphique et des réglages choisis par Harn.

- Référence des leviers d'inférence : ${LEVERS_DOC}
- Carnet de cette machine (mesures, analyse, notes) : ${machine}

Si une tâche porte sur les performances, les réglages ou le matériel de cette machine, lis ces
deux fichiers d'abord. Si tu constates quelque chose de mesuré sur cette machine (un débit,
un réglage essayé, un problème), ajoute une note datée dans la section « Notes au fil de
l'usage » du carnet, la plus récente en haut, en citant la mesure. Ne modifie jamais ce qui
se trouve entre les marqueurs \`<!-- harn:... -->\` : Harn les réécrit.
`;
}
