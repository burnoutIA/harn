import './helpers/home.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createKey, loadKeys } from '../src/api-keys.mjs';
import { requestApproval, approvalOf } from '../src/approvals.mjs';
import { handleV1 } from '../src/gateway.mjs';
import { _setPeers, addPeer, decideRemote, peersReport, refreshApprovals, removePeer, setPilotKey } from '../src/peers.mjs';
import { getState } from '../src/state.mjs';

const listen = (handler) => new Promise((resolve) => { const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(server)); });

// Le même processus joue les deux machines : la passerelle réseau de la machine pilotée (vraies
// clés, vraies demandes d'accord) et le pilote qui la relève.
test('une machine pilotée : ses demandes se voient et se décident ici, avec la seule clé de pilotage', async () => {
  await loadKeys();
  const client = await createKey('Pilote — modèles');
  const pilot = await createKey('Pilote — accords', { pilot: true });
  assert.equal(pilot.key.pilot, true);
  assert.equal(client.key.pilot, false);

  const gateway = await listen((req, res) => handleV1(req, res, new URL(req.url, 'http://lan'), { lan: true }));
  const url = `http://127.0.0.1:${gateway.address().port}/v1`;
  try {
    // Une clé de client n'ouvre pas les demandes d'accord.
    const refused = await fetch(`${url}/harn/approvals`, { headers: { Authorization: `Bearer ${client.token}` } });
    assert.equal(refused.status, 403);

    _setPeers([]);
    await addPeer({ name: 'pc2', url, key: client.token });
    await assert.rejects(setPilotKey('pc2', client.token), /pas une clé de pilotage/);
    await assert.rejects(setPilotKey('pc2', 'sk-harn-inconnue'), /refusée/);
    assert.equal(peersReport()[0].pilot.on, false);

    let ran = 0;
    const id = requestApproval({ kind: 'install', title: 'Installer Inkling', detail: '17 Go', run: () => { ran += 1; } });
    await setPilotKey('pc2', pilot.token);
    assert.deepEqual(peersReport()[0].pilot, { on: true, ok: true, error: null });
    // La demande de « là-bas » s'affiche ici, marquée de sa machine.
    const remote = getState().approvalsRemote;
    assert.equal(remote.length, 1);
    assert.deepEqual({ id: remote[0].id, title: remote[0].title, peerId: remote[0].peerId }, { id, title: 'Installer Inkling', peerId: 'pc2' });

    const decided = await decideRemote('pc2', id, true);
    assert.equal(decided.status, 'accepted');
    assert.equal(ran, 1);
    assert.equal(approvalOf(id).status, 'accepted');
    assert.deepEqual(getState().approvalsRemote, [], 'la demande décidée disparaît ici');
    await assert.rejects(decideRemote('pc2', id, true), { status: 409 });

    // Sans clé de pilotage, plus rien n'est relevé.
    requestApproval({ kind: 'install', title: 'Autre', detail: '', run: () => {} });
    await setPilotKey('pc2', null);
    await refreshApprovals();
    assert.deepEqual(getState().approvalsRemote, []);
    await assert.rejects(decideRemote('pc2', 'abcdefabcdef', true), { status: 409 });
    await removePeer('pc2');
  } finally {
    gateway.close();
  }
});
