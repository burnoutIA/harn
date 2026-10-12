import './helpers/home.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// L'extension Telegram face à un faux pi et à un faux Telegram : aucun réseau, aucun vrai bot.
const dir = path.join(process.env.HARN_HOME, 'pi-telegram');
mkdirSync(dir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = dir;
process.env.HARN_TELEGRAM_CLAIM_MS = '10';
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
// harn : les réponses successives de Harn à la demande de carte, puis à la lecture de la décision.
function fakeTelegram(updates, harn = []) {
  const calls = [];
  globalThis.fetch = async (url, { body, signal } = {}) => {
    if (String(url).startsWith('http://harn')) {
      calls.push(['harn', String(url).slice('http://harn'.length)]);
      const answer = harn.shift();
      return { json: async () => answer };
    }
    // Le contenu d'un fichier : servi à l'adresse que getFile a donnée.
    if (String(url).includes('/file/bot')) {
      calls.push(['download', String(url).split('/file/bot')[1]]);
      return { ok: !String(url).includes('perdu'), status: 404, arrayBuffer: async () => Buffer.from('contenu du fichier') };
    }
    const method = String(url).split('/').pop();
    // Un fichier envoyé : un formulaire, pas du JSON.
    if (body instanceof FormData) {
      calls.push([method, { chat_id: Number(body.get('chat_id')), file: (body.get('photo') ?? body.get('document')).name }]);
      return { json: async () => ({ ok: true, result: true }) };
    }
    const params = JSON.parse(body);
    calls.push([method, params]);
    let result = true;
    if (method === 'getFile') result = { file_path: `documents/${params.file_id}.bin` };
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

test('carte occupée : la personne est prévenue, puis servie ou refusée selon la décision', async () => {
  writeFileSync(path.join(dir, 'telegram.json'), JSON.stringify({ token: 'jeton-de-test', ownerId: OWNER, agent: 'eloise', harn: 'http://harn' }));
  const calls = fakeTelegram(
    [message(7, 'libre'), message(8, 'on me laisse la place'), message(9, 'on me refuse')],
    [{ status: 'free' }, { status: 'pending', approval: 'a1' }, { status: 'pending' }, { status: 'accepted' }, { status: 'pending', approval: 'a2' }, { status: 'refused' }],
  );
  const pi = fakePi();
  (await load())(pi);
  pi.emit('session_start');
  await new Promise((resolve) => setTimeout(resolve, 250));
  pi.emit('session_shutdown');
  assert.deepEqual(pi.sent.map(([text]) => text), ['libre', 'on me laisse la place']);
  assert.deepEqual(calls.filter(([kind]) => kind === 'harn').map(([, url]) => url), ['/api/agents/eloise/claim', '/api/agents/eloise/claim', '/api/approvals/a1', '/api/approvals/a1', '/api/agents/eloise/claim', '/api/approvals/a2']);
  const texts = calls.filter(([method]) => method === 'sendMessage').map(([, params]) => params.text);
  assert.equal(texts.filter((text) => /occupée/.test(text)).length, 2);
  assert.equal(texts.filter((text) => /pas possible/.test(text)).length, 1);
});

test('photos et fichiers : rangés dans files/, annoncés à l’agent, montrés au modèle qui sait voir', async () => {
  const files = path.join(process.env.HARN_HOME, 'workspace-telegram', 'files');
  writeFileSync(path.join(dir, 'telegram.json'), JSON.stringify({ token: 'jeton-de-test', ownerId: OWNER, files }));
  const attached = (update_id, extra) => ({ update_id, message: { message_id: update_id, chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, ...extra } });
  const photo = [{ file_id: 'petite', file_size: 10 }, { file_id: 'grande', file_size: 900 }];
  const calls = fakeTelegram([
    attached(20, { photo, caption: 'regarde ça' }),
    attached(21, { document: { file_id: 'doc', file_name: '../../Relevé été 2026.pdf', mime_type: 'application/pdf', file_size: 1200 } }),
    attached(22, { document: { file_id: 'enorme', file_name: 'film.mkv', mime_type: 'video/x-matroska', file_size: 50 * 1024 * 1024 }, caption: 'trop gros' }),
    attached(23, { document: { file_id: 'perdu', file_name: 'note.txt', mime_type: 'text/plain', file_size: 5 } }),
    attached(24, { sticker: { file_id: 'autocollant' } }),
  ]);
  const pi = fakePi();
  (await load())(pi);
  // Le modèle chargé sait voir : la photo lui est jointe en plus d'être rangée.
  pi.emit('session_start');
  pi.emit('model_select', { model: { input: ['text', 'image'] } });
  await settle();
  pi.emit('session_shutdown');

  const [withPhoto, withDocument, tooBig] = pi.sent.map(([content]) => content);
  assert.equal(pi.sent.length, 3);
  assert.match(withPhoto[0].text, /^regarde ça\n\n\[Fichier reçu par Telegram, enregistré dans .*photo(-\d+)?\.jpg \(image\/jpeg/);
  assert.deepEqual(withPhoto[1], { type: 'image', data: Buffer.from('contenu du fichier').toString('base64'), mimeType: 'image/jpeg' });
  // La plus grande taille de la photo, et un nom de fichier qui ne sort pas du dossier.
  assert.ok(calls.some(([method, params]) => method === 'getFile' && params.file_id === 'grande'));
  assert.match(withDocument, /^\[Fichier reçu par Telegram, enregistré dans .*Releve-ete-2026\.pdf \(application\/pdf/);
  const saved = readdirSync(files);
  assert.equal(saved.length, 2);
  assert.ok(saved.every((name) => /^\d{8}-\d{6}-/.test(name)));
  assert.equal(readFileSync(path.join(files, saved.find((name) => name.endsWith('.pdf'))), 'utf8'), 'contenu du fichier');
  // Trop gros ou introuvable : la personne est prévenue, la légende passe quand même.
  assert.equal(tooBig, 'trop gros');
  const texts = calls.filter(([method]) => method === 'sendMessage').map(([, params]) => params.text);
  assert.equal(texts.filter((text) => /pas pu récupérer votre fichier/.test(text)).length, 2);
});

test('un modèle qui ne voit pas reçoit le chemin de l’image, pas l’image', async () => {
  fakeTelegram([{ update_id: 30, message: { message_id: 30, chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, photo: [{ file_id: 'p', file_size: 10 }] } }]);
  const pi = fakePi();
  (await load())(pi);
  pi.emit('session_start');
  await settle();
  pi.emit('session_shutdown');
  assert.equal(typeof pi.sent[0][0], 'string');
  assert.match(pi.sent[0][0], /photo(-\d+)?\.jpg .*ne sait pas voir/);
});

test('une image produite par l’agent part dans le chat de la personne', async () => {
  const calls = fakeTelegram([message(40, 'dessine un chat')]);
  const pi = fakePi();
  (await load())(pi);
  pi.emit('session_start');
  await settle();
  const made = path.join(process.env.HARN_HOME, 'chat.png');
  writeFileSync(made, 'image');
  writeFileSync(path.join(process.env.HARN_HOME, 'notes.pdf'), 'document');
  // L'extension image-gen passe par l'objet partagé, sans connaître le bot.
  globalThis.__harnTelegram.sendFile(made);
  globalThis.__harnTelegram.sendFile(path.join(process.env.HARN_HOME, 'notes.pdf'));
  await settle();
  pi.emit('session_shutdown');
  assert.deepEqual(calls.filter(([method]) => /^send(Photo|Document)$/.test(method)), [['sendPhoto', { chat_id: OWNER, file: 'chat.png' }], ['sendDocument', { chat_id: OWNER, file: 'notes.pdf' }]]);
});
