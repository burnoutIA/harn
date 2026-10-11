import './helpers/home.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// L'extension Telegram face à un faux pi et à un faux Telegram : aucun réseau, aucun vrai bot.
const dir = path.join(process.env.HARN_HOME, 'pi-telegram');
mkdirSync(dir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = dir;
const OWNER = 42;

function fakePi() {
  const handlers = {};
  const pi = {
    sent: [],
    commands: {},
    on: (event, handler) => { handlers[event] = handler; },
    registerCommand: (name, options) => { pi.commands[name] = options; },
    sendUserMessage: (text, options) => { pi.sent.push([text, options]); },
    emit: (event, payload = {}) => handlers[event]?.(payload, { ui: { notify: (message) => pi.notices.push(message) } }),
    notices: [],
  };
  return pi;
}

// Telegram simulé : une file de mises à jour servie une fois, puis des attentes vides.
function fakeTelegram(updates) {
  const calls = [];
  globalThis.fetch = async (url, { body, signal }) => {
    const method = String(url).split('/').pop();
    const params = JSON.parse(body);
    calls.push([method, params]);
    let result = true;
    if (method === 'getUpdates') {
      result = updates.splice(0).filter((u) => u.update_id >= params.offset);
      if (!result.length) await new Promise((resolve, reject) => { const t = setTimeout(resolve, 20); signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('abandon')); }); });
    }
    return { json: async () => ({ ok: true, result }) };
  };
  return calls;
}
const message = (update_id, text, from = OWNER, chat = { id: OWNER, type: 'private' }) => ({ update_id, message: { message_id: update_id, chat, from: { id: from }, text } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const load = async () => (await import(`../src/pi-extensions/telegram-follow/index.ts?${Math.random()}`)).default;

test('sans telegram.json, l’extension ne branche rien', async () => {
  const pi = fakePi();
  (await load())(pi);
  assert.deepEqual(pi.commands, {});
  assert.equal(pi.emit('session_start'), undefined);
});

test('seule la personne est écoutée ; /new passe par la commande, le reste va à l’agent', async () => {
  writeFileSync(path.join(dir, 'telegram.json'), JSON.stringify({ token: 'jeton-de-test', ownerId: OWNER }));
  const calls = fakeTelegram([
    message(1, 'bonjour'),
    message(2, 'intrus', 7, { id: 7, type: 'private' }),
    message(3, 'depuis un groupe', OWNER, { id: -100, type: 'group' }),
    message(4, 'un autre dans le groupe', 7, { id: -100, type: 'group' }),
    message(5, '/new@mon_bot'),
  ]);
  const pi = fakePi();
  (await load())(pi);
  pi.emit('session_start');
  await settle();
  assert.deepEqual(pi.sent.map(([text]) => text), ['bonjour', 'depuis un groupe', '/telegram-new']);
  assert.ok(existsSync(path.join(dir, 'telegram.lock')));
  assert.ok(calls.some(([method, params]) => method === 'sendChatAction' && params.action === 'typing'));
  assert.ok(calls.some(([method]) => method === 'setMyCommands'));

  // La réponse finale part vers le dernier chat qui a écrit, et le voyant s'éteint.
  pi.emit('turn_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'Voilà.' }] } });
  pi.emit('agent_settled');
  await settle();
  assert.deepEqual(calls.filter(([method]) => method === 'sendMessage').map(([, params]) => [params.chat_id, params.text]), [[OWNER, 'Voilà.']]);
  const typed = calls.filter(([method]) => method === 'sendChatAction').length;

  // La session fermée rend le verrou, éteint le voyant et cesse de lire la file.
  pi.emit('session_shutdown');
  await settle();
  assert.ok(!existsSync(path.join(dir, 'telegram.lock')));
  assert.equal(calls.filter(([method]) => method === 'sendChatAction').length, typed);
  const polls = calls.filter(([method]) => method === 'getUpdates').length;
  await settle();
  assert.equal(calls.filter(([method]) => method === 'getUpdates').length, polls);
});

test('la session suivante reprend la file après le dernier message lu', async () => {
  const calls = fakeTelegram([message(5, '/new'), message(6, 'suite')]);
  const pi = fakePi();
  (await load())(pi);
  pi.emit('session_start');
  await settle();
  pi.emit('session_shutdown');
  assert.equal(calls.find(([method]) => method === 'getUpdates')[1].offset, 6);
  assert.deepEqual(pi.sent.map(([text]) => text), ['suite']);
});
