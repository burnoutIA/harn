// Gérer les clés API sans ouvrir l'interface : « npm run keys -- create "Portable — Copilot" ».
// « create --pilot "Tour" » : une clé de pilotage, pour décider d'ici depuis une autre machine Harn.
// Harn relit data/api-keys.json quand il change : inutile de le redémarrer.
import { createKey, listKeys, loadKeys, revokeKey } from './api-keys.mjs';
import { getState, loadState } from './state.mjs';

const [command, ...rest] = process.argv.slice(2);

try {
  await loadKeys();
  if (command === 'create') {
    const pilot = rest[0] === '--pilot';
    const { token, key } = await createKey((pilot ? rest.slice(1) : rest).join(' '), { pilot });
    console.log(`Clé${pilot ? ' de pilotage' : ''} « ${key.label} » créée (${key.id}). Copiez-la maintenant, elle ne sera plus affichée :\n\n  ${token}\n`);
    console.log(pilot ? 'Sur l’autre machine Harn : Machine › Autres machines Harn › Piloter, avec cette clé.' : 'Dans le client : api_key = cette clé. Sans champ clé (Copilot) : http://127.0.0.1:4747/k/<clé>/v1');
  } else if (command === 'list') {
    const { state, error, keys } = await listKeys();
    if (error) console.log(`Attention : ${error}`);
    if (!keys.length) console.log(state === 'invalid' ? 'Aucune clé lisible : toute requête est refusée.' : 'Aucune clé : /v1 répond sans clé, à cette machine seulement.');
    for (const k of keys) console.log(`${k.id}  ${k.label}${k.pilot ? ' (pilotage)' : ''}  ·  ${k.requests} requêtes, ${k.tokens} tokens, ${k.lastUsedAt ? `dernière le ${new Date(k.lastUsedAt).toLocaleString('fr-FR')}` : 'jamais utilisée'}`);
  } else if (command === 'revoke' && rest[0]) {
    await loadState();
    const revoked = await revokeKey(rest[0], { keepOne: Boolean(getState().lan) });
    console.log(`Clé « ${revoked.label} » révoquée.`);
  } else {
    console.log('Usage : npm run keys -- create [--pilot] "<nom>" | list | revoke <id>');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
