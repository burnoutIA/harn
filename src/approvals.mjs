import { randomBytes } from 'node:crypto';
import { getState, update } from './state.mjs';

// Ce que pi demande et que seul l'utilisateur peut accorder (télécharger des dizaines de Go,
// relancer une installation). Avant, pi affirmait lui-même « user_confirmed: true » : une
// injection de prompt (README Hugging Face, page web lue par ketch) suffisait. La demande
// s'affiche dans la fenêtre de Harn ; la réponse vient d'un clic, que le modèle ne peut pas faire.
// Les demandes vivent dans state.approvals (l'interface les reçoit par /api/events) ; elles ne
// survivent pas à un redémarrage.

const actions = new Map(); // id → fonction lancée à l'acceptation
const KEEP_DECIDED_MS = 10 * 60_000;

export function requestApproval({ kind, title, detail, run }) {
  const id = randomBytes(6).toString('hex');
  actions.set(id, run);
  update((s) => {
    s.approvals = (s.approvals ?? []).filter((a) => a.status === 'pending' || Date.now() - a.decidedAt < KEEP_DECIDED_MS);
    s.approvals.push({ id, kind, title, detail, status: 'pending', at: Date.now(), decidedAt: null, error: null });
  });
  return id;
}

export const approvalOf = (id) => (getState().approvals ?? []).find((a) => a.id === id) ?? null;

export function decideApproval(id, accept) {
  const entry = approvalOf(id);
  if (!entry) throw Object.assign(new Error('Demande inconnue ou expirée'), { status: 404 });
  if (entry.status !== 'pending') throw Object.assign(new Error('Demande déjà traitée'), { status: 409 });
  const run = actions.get(id);
  actions.delete(id);
  let error = null;
  // Lancé avant la mise à jour : quand pi lit « accepted », le travail est déjà en route.
  if (accept) { try { run?.(); } catch (caught) { error = caught.message; } }
  update((s) => {
    const target = s.approvals.find((a) => a.id === id);
    Object.assign(target, { status: error ? 'error' : accept ? 'accepted' : 'refused', decidedAt: Date.now(), error });
  });
  return approvalOf(id);
}
