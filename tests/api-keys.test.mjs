import './helpers/home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { bearerToken, extractPathKey, fingerprint, generateKey, hashKey } from '../src/api-keys.mjs';
import { lanAddresses } from '../src/lan.mjs';

test('la clé voyage dans le chemin et le préfixe disparaît avant le routage', () => {
  assert.deepEqual(extractPathKey('/k/sk-harn-abc/v1/chat/completions'), { token: 'sk-harn-abc', pathname: '/v1/chat/completions' });
  assert.deepEqual(extractPathKey('/k/sk-harn-abc'), { token: 'sk-harn-abc', pathname: '/' });
  assert.deepEqual(extractPathKey('/v1/models'), { token: null, pathname: '/v1/models' });
  // Un encodage invalide ne fait pas tomber la passerelle.
  assert.equal(extractPathKey('/k/%E0%A4%A/v1/models').pathname, '/v1/models');
});

test('seul le schéma Bearer est lu', () => {
  assert.equal(bearerToken({ authorization: 'Bearer sk-harn-x' }), 'sk-harn-x');
  assert.equal(bearerToken({ authorization: 'bearer   sk-harn-x  ' }), 'sk-harn-x');
  assert.equal(bearerToken({ authorization: 'Bearer' }), null);
  assert.equal(bearerToken({ authorization: 'Basic abc' }), null);
  assert.equal(bearerToken({}), null);
});

test('une clé générée est longue, préfixée, et jamais journalisée en entier', () => {
  const key = generateKey();
  assert.match(key, /^sk-harn-[\w-]{43}$/);
  assert.notEqual(generateKey(), key);
  assert.equal(hashKey(key).length, 64);
  assert.ok(!fingerprint(key).includes(key.slice(12)));
  assert.equal(fingerprint(null), 'aucune');
});

test('les adresses réseau privées passent avant les cartes virtuelles', () => {
  const list = lanAddresses({
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
    Ethernet: [{ family: 'IPv4', address: '192.168.1.42', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    APIPA: [{ family: 'IPv4', address: '169.254.3.3', internal: false }],
  });
  assert.deepEqual(list.map((a) => a.address), ['192.168.1.42', '172.20.0.1']);
  assert.match(list[0].url, /^http:\/\/192\.168\.1\.42:\d+\/v1$/);
});
