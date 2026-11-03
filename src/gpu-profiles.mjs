// Les réglages mesurés appartiennent à la carte qui les a mesurés. Contexte, KV, moteur, débit :
// rien de tout ça ne vaut sur une autre carte. L'intelligence d'un modèle (iq) et l'usage choisi,
// eux, suivent le modèle et restent en place.
//
// state.profiles garde les réglages de la carte présente, comme avant : le reste de Harn n'a pas
// à savoir qu'il existe d'autres cartes. Quand la carte change, les réglages de l'ancienne partent
// dans state.gpuArchive[nom] et ceux de la nouvelle, si elle a déjà été mesurée ici, reviennent.
// Rien n'est jamais effacé : remettre l'ancienne carte reprend ses réglages tels quels.

const PER_CARD = ['tuning', 'bench'];

// La carte d'un relevé. Le nom suffit : c'est lui que chaque banc note dans bench.gpu.
export const cardKey = (hardware) => hardware?.primary?.name ?? null;

// Pour un état d'avant ce rangement : la carte la plus souvent notée par les bancs.
export function inferCard(profiles) {
  const counts = new Map();
  for (const profile of Object.values(profiles ?? {})) {
    const gpu = profile.bench?.gpu;
    if (gpu) counts.set(gpu, (counts.get(gpu) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// Range les réglages selon la carte détectée. Modifie l'état reçu ; renvoie le changement s'il y en a un.
export function switchCard(state, hardware, now = new Date()) {
  const next = cardKey(hardware);
  // Pas de carte vue : pilote absent, relevé raté… On ne range rien sur la foi d'un trou.
  if (!next) return null;
  const previous = state.gpuKey ?? inferCard(state.profiles);
  state.gpuKey = next;
  if (!previous || previous === next) return null;

  state.gpuArchive ??= {};
  const shelf = { savedAt: now.toISOString(), profiles: {} };
  for (const [id, profile] of Object.entries(state.profiles ?? {})) {
    const kept = Object.fromEntries(PER_CARD.filter((field) => profile[field] !== undefined).map((field) => [field, profile[field]]));
    if (!Object.keys(kept).length) continue;
    shelf.profiles[id] = kept;
    for (const field of PER_CARD) delete profile[field];
  }
  const archived = Object.keys(shelf.profiles).length;
  if (archived) state.gpuArchive[previous] = shelf;

  let restored = 0;
  const back = state.gpuArchive[next];
  if (back) {
    for (const [id, kept] of Object.entries(back.profiles)) {
      Object.assign((state.profiles[id] ??= {}), kept);
      restored += 1;
    }
    delete state.gpuArchive[next];
  }

  state.gpuChange = { from: previous, to: next, archived, restored, at: now.toISOString() };
  return state.gpuChange;
}

// Le bandeau qui l'annonce, tant que l'utilisateur ne l'a pas lu.
export function gpuChangeCheck(change) {
  if (!change) return null;
  const text = change.restored
    ? `Harn reprend les réglages déjà mesurés sur cette carte (${change.restored} modèle${change.restored > 1 ? 's' : ''}). Ceux de la ${change.from} sont mis de côté et reviendront si elle revient.`
    : `Les réglages mesurés sur la ${change.from} sont mis de côté : rien n’est perdu, ils reviendront si elle revient. Les modèles repartent des valeurs de départ : relancez le banc de chacun pour mesurer cette carte.`;
  return { id: 'gpu-change', level: 'warn', title: `Nouvelle carte : ${change.to}`, text, action: { id: 'gpu-change-ok', label: 'Compris' } };
}

// Les modèles installés qui n'ont encore aucune mesure sur la carte présente, et ceux que cette
// carte ne peut pas faire tourner du tout (pile CUDA sur une Radeon, par exemple).
export function benchTodo(state) {
  const verdicts = new Map((state.plan?.verdicts ?? []).map((verdict) => [verdict.id, verdict]));
  const installed = Object.keys(state.models ?? {}).filter((id) => state.models[id]?.installedAt);
  const unusable = installed.filter((id) => verdicts.get(id)?.fit === 'no');
  const toMeasure = installed.filter((id) => !unusable.includes(id) && !state.profiles?.[id]?.bench);
  return { toMeasure, unusable };
}
