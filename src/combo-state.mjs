import { getState } from './state.mjs';

// Le combo qui tient la carte (combo.mjs), lu par ceux qui pourraient la lui prendre : le
// placement des modèles de texte, la voix, l'inactivité, les images et le banc. Un module à part,
// sans dépendance, pour qu'ils le lisent sans s'importer les uns les autres.

// Le combo en vigueur : en démarrage ou prêt. Un combo en échec ne réserve plus rien.
export const comboOf = () => {
  const combo = getState().combo;
  return combo && ['starting', 'ready'].includes(combo.status) ? combo : null;
};
export const comboMember = (id) => Boolean(comboOf()?.models?.some((m) => m.id === id));
// Le modèle de texte du combo (avec son réglage), ou null.
export const comboText = (id) => comboOf()?.models?.find((m) => m.id === id && m.kind === 'text') ?? null;
// L'identifiant du modèle de voix du combo, ou null.
export const comboVoice = () => comboOf()?.models?.find((m) => m.kind === 'voice')?.id ?? null;
export const comboLabel = () => (comboOf()?.models ?? []).map((m) => m.name ?? m.id).join(' + ');

// Ce qu'on répond à qui voudrait prendre la place du combo : refusé, jamais déchargé.
export function comboRefusal(what) {
  return Object.assign(new Error(`Un combo tient la carte graphique (${comboLabel()}) : ${what} attendra qu’il s’arrête (vue Modèles, ou POST /v1/combos/stop)`), { status: 409, code: 'combo' });
}
