#!/usr/bin/env node
// Serveur MCP de Harn (stdio, JSON-RPC 2.0, une ligne par message). pi s'en sert pour installer
// un modèle depuis Hugging Face : il juge (quel fichier, quels réglages), Harn exécute (télé-
// chargement, banc, test d'intelligence). Les outils appellent l'application qui tourne.

import { createInterface } from 'node:readline';

const HARN = `http://127.0.0.1:${process.env.HARN_PORT ?? 4747}`;
const VERSION = '0.1.0';

const TOOLS = [
  {
    name: 'inspect_model_repo',
    description: 'Analyse un dépôt Hugging Face de modèle GGUF pour CETTE machine : architecture exacte (couches, MoE, MTP, coût du cache KV), licence, accès, fichiers vision, réglages recommandés par l’auteur, et pour chaque quantification le contexte qui tient sur la carte et la vitesse estimée à 100k. À appeler en premier.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Adresse du dépôt, ex. https://huggingface.co/auteur/modele-GGUF' } }, required: ['url'] },
  },
  {
    name: 'install_model',
    description: 'Télécharge une quantification choisie, la règle et la mesure (banc par étapes), puis lance le banc d’intelligence. Harn affiche d’abord la demande (dépôt, taille, licence) dans sa fenêtre : rien ne démarre avant que l’utilisateur clique sur Accepter. Préviens-le avant d’appeler l’outil. Bloque jusqu’à la fin (plusieurs minutes) et rend les résultats.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Adresse du dépôt Hugging Face' },
        quant: { type: 'string', description: 'Nom exact de la quantification, tel que rendu par inspect_model_repo (ex. UD-IQ4_XS)' },
        mmproj: { type: 'string', description: 'Fichier projecteur vision à installer (optionnel ; à omettre si l’auteur dit que la vision est incompatible avec MTP)' },
        sampling: { type: 'object', description: 'Réglages d’échantillonnage recommandés par l’auteur : temperature, top_p, top_k, min_p, presence_penalty, repeat_penalty', additionalProperties: { type: 'number' } },
      },
      required: ['url', 'quant'],
    },
  },
  {
    name: 'read_install_log',
    description: 'Lit le journal d’installation d’un modèle (200 dernières lignes) et son erreur : à appeler en premier pour comprendre un échec.',
    inputSchema: { type: 'object', properties: { model_id: { type: 'string' } }, required: ['model_id'] },
  },
  {
    name: 'retry_install',
    description: 'Relance l’installation d’un modèle du catalogue (fichiers, réglages, banc d’intelligence) et attend la fin. Comme install_model, la relance attend que l’utilisateur l’accepte dans la fenêtre de Harn. gguf_dir : dossier contenant déjà tous les fichiers GGUF du modèle, pour ne pas les retélécharger.',
    inputSchema: { type: 'object', properties: { model_id: { type: 'string' }, gguf_dir: { type: 'string' } }, required: ['model_id'] },
  },
  {
    name: 'harn_status',
    description: 'État de Harn : machine, objectif, modèle actif, téléchargements en cours, modèles installés avec leur vitesse mesurée et leur score au test d’intelligence.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'test_intelligence',
    description: 'Lance le banc d’intelligence de Harn sur un modèle installé (test adaptatif par paliers en cinq domaines : outils, code, raisonnement, long contexte, honnêteté) et rend la note sur 100, le palier atteint par domaine et le marqueur de réflexion. Le modèle est chargé si besoin. Une à deux minutes.',
    inputSchema: { type: 'object', properties: { model_id: { type: 'string' } }, required: ['model_id'] },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const text = (value, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], isError });

async function api(method, path, body) {
  const response = await fetch(`${HARN}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Harn a répondu ${response.status}`);
  return payload;
}

// Les longues opérations envoient une progression toutes les 10 s : pi remet alors son délai à zéro.
async function withProgress(token, task) {
  if (token === undefined) return task();
  let step = 0;
  const timer = setInterval(async () => {
    step += 1;
    const status = await api('GET', '/api/status').catch(() => null);
    const busy = status?.models?.find((m) => m.installing || m.tuning || m.iqRunning);
    const download = status?.downloads?.[0];
    const message = download ? `Téléchargement ${download.percent ?? '?'} % (${download.speedMBps ?? '?'} Mo/s)` : busy?.tuning ?? busy?.iqRunning ?? 'En cours…';
    send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: step, message } });
  }, 10_000);
  try { return await task(); } finally { clearInterval(timer); }
}

// La demande attend un clic dans la fenêtre de Harn. Rend null une fois acceptée, sinon le
// message d'échec à rendre à pi.
const APPROVAL_TIMEOUT_MS = 15 * 60_000;
async function waitApproval(id, token) {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  let step = 0;
  while (Date.now() < deadline) {
    const entry = await api('GET', `/api/approvals/${id}`).catch((error) => ({ status: 'lost', error: error.message }));
    if (entry.status === 'accepted') return null;
    if (entry.status === 'refused') return 'L’utilisateur a refusé dans la fenêtre de Harn. Ne relance pas sans qu’il le demande.';
    if (entry.status === 'error') return `Acceptée, mais Harn n’a pas pu démarrer : ${entry.error}`;
    if (entry.status === 'lost') return `La demande a disparu (${entry.error}).`;
    if (token !== undefined && step % 5 === 0) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: step, message: 'En attente de l’accord de l’utilisateur dans la fenêtre de Harn' } });
    step += 1;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return 'Pas de réponse de l’utilisateur dans la fenêtre de Harn au bout de 15 minutes : demande abandonnée.';
}

async function call(name, args, token) {
  if (name === 'inspect_model_repo') return text(await api('POST', '/api/hf/inspect', { url: args.url }));
  if (name === 'harn_status') return text(await api('GET', '/api/status'));
  if (name === 'read_install_log') return text(await api('GET', `/api/models/${encodeURIComponent(args.model_id)}/log`));
  if (name === 'retry_install') {
    const asked = await api('POST', `/api/models/${encodeURIComponent(args.model_id)}/retry`, { gguf_dir: args.gguf_dir });
    const refused = asked.approval ? await waitApproval(asked.approval, token) : null;
    if (refused) return text(refused, true);
    let step = 0;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const status = await api('GET', `/api/models/${encodeURIComponent(args.model_id)}/log`).catch(() => null);
      if (!status) continue;
      if (!status.installing && (status.installed || status.error)) {
        const full = await api('GET', '/api/status');
        const model = full.models.find((m) => m.id === args.model_id);
        if (model?.tuning || model?.iqRunning) { step += 1; continue; }
        return status.error && !status.installed ? text(`Échec : ${status.error}`, true) : text({ installed: true, model });
      }
      if (token !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: (step += 1), message: status.log.split('\n').filter(Boolean).pop()?.slice(0, 160) ?? 'En cours…' } });
    }
  }
  if (name === 'install_model') {
    const asked = await api('POST', '/api/custom/install', { url: args.url, quant: args.quant, mmproj: args.mmproj, sampling: args.sampling });
    const refused = asked.approval ? await waitApproval(asked.approval, token) : null;
    if (refused) return text(refused, true);
    let step = 0;
    let last = '';
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const job = await api('GET', '/api/custom/job').catch(() => null);
      if (!job) continue;
      if (!job.running) return job.error ? text(`Échec : ${job.error}`, true) : text(job.result);
      const status = job.step === 'download' ? await api('GET', '/api/status').catch(() => null) : null;
      const download = status?.downloads?.[0];
      const message = download ? `Téléchargement ${download.percent ?? '?'} % (${download.speedMBps ?? '?'} Mo/s)` : job.detail;
      if (token !== undefined && (message !== last || step % 6 === 0)) {
        send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: step, message } });
        last = message;
      }
      step += 1;
    }
  }
  if (name === 'test_intelligence') {
    await api('POST', `/api/models/${encodeURIComponent(args.model_id)}/iq`);
    return text(await withProgress(token, async () => {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const status = await api('GET', '/api/status');
        const model = status.models.find((m) => m.id === args.model_id);
        if (model && !model.iqRunning) return { model: model.id, intelligence: model.intelligence };
      }
    }));
  }
  return text(`Outil inconnu : ${name}`, true);
}

const lines = createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (id === undefined) return; // notifications (initialized, cancelled…)
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'harn', version: VERSION },
        instructions: 'Outils de Harn, le serveur d’IA locale de cette machine : analyser un modèle Hugging Face, l’installer, le mesurer et tester son intelligence.',
      } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      const result = await call(params.name, params.arguments ?? {}, params._meta?.progressToken).catch((error) => text(error.message, true));
      return send({ jsonrpc: '2.0', id, result });
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Méthode inconnue : ${method}` } });
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } });
  }
});
