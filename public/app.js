// L'interface ne calcule rien d'elle-même : elle lit l'état publié par le serveur (/api/events)
// et le met en forme. Chaque zone n'est réécrite que si son contenu change.

const app = document.getElementById('app');
const statusEl = document.getElementById('status');
const navEl = document.getElementById('nav');
const toastEl = document.getElementById('toast');
const API = `${location.origin}/v1`;

let state = null;
let live = null;
let catalog = [];
let benchMarks = null;
const benchMarksOf = () => JSON.stringify(Object.values(state.profiles ?? {}).map((p) => [p.iq?.at, p.bench?.winner?.tps, p.tuning?.context]));
let view = 'home';
let doc = { text: '', at: null };
let piSystem = { text: null, file: '' };
let ketchTest = null;
let access = null;  // clés API et réseau local (/api/access)
let newKey = null;  // la clé tout juste créée : affichée une seule fois
const approvalsEl = document.getElementById('approvals');
const baseTitle = document.title;

document.querySelector('#endpoint .endpoint-v').textContent = API.replace('http://', '');
document.getElementById('endpoint').addEventListener('click', () => copy(API, 'Adresse de l’API copiée'));

// ── Utilitaires ────────────────────────────────────────────
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fr = (value, digits = 0) => Number(value).toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const gb = (bytes) => `${fr(bytes / 1e9, bytes >= 1e11 ? 0 : 1)} Go`;
const rate = (bps) => (bps >= 1e6 ? `${fr(bps / 1e6)} Mo/s` : `${fr(bps / 1e3)} ko/s`);
const kTokens = (tokens) => `${Math.round(tokens / 1024)}k`;
const clock = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h ${String(Math.round((seconds % 3600) / 60)).padStart(2, '0')}`;
}
const modelOf = (id) => catalog.find((m) => m.id === id);
const verdictOf = (id) => state.plan?.verdicts?.find((v) => v.id === id);
// Note globale (mesurée ou estimée) et, pour la cible, pourquoi elle passe devant un modèle plus intelligent.
const ratingFact = (id) => { const v = verdictOf(id); return v?.rating != null ? `<div class="fact" title="Intelligence 40 % · taille 25 % · vitesse 20 % · contexte 15 %"><b>${v.rating}</b>note globale${v.ratingMeasured ? '' : ' estimée'}</div>` : ''; };
const whyTarget = (id) => (state.plan?.targetWhy && state.plan.targetModel === id ? `<p class="why">${esc(state.plan.targetWhy)}</p>` : '');
const moeOf = (model) => Boolean(model?.rating?.moe ?? (model?.sparse || model?.moe));
const nameOf = (id) => modelOf(id)?.name ?? id;
const iqOf = (id) => { const v = verdictOf(id); return { value: v?.intelligence ?? modelOf(id)?.quality ?? null, tested: Boolean(v?.tested) }; };
// Même règle que le serveur : la meilleure note globale parmi les modèles installés, autre que celui en cause, qui savent manier des outils.
const ratingOf = (id) => modelOf(id)?.rating?.score ?? state.profiles[id].iq.score * 0.4;
const helperFor = (failedId) => Object.entries(state.profiles ?? {})
  .filter(([id, p]) => id !== failedId && state.models[id]?.installedAt && p.iq?.version === IQ_VERSION && p.iq.categories.outils.ratio >= 0.4)
  .sort(([a], [b]) => ratingOf(b) - ratingOf(a))[0]?.[0] ?? null;
// Même version que src/iq-test.mjs : les résultats d'un ancien banc sont à refaire.
const IQ_VERSION = 3;
const iqResult = (id) => (state.profiles[id]?.iq?.version === IQ_VERSION ? state.profiles[id].iq : null);
// Les cinq domaines du banc d'intelligence : [clé, nom, poids dans la note].
const CATS = [['outils', 'Outils', 35], ['code', 'Code', 25], ['raisonnement', 'Raisonnement', 20], ['contexte', 'Long contexte', 10], ['honnetete', 'Honnêteté', 10]];
// Un modèle peut être meilleur généraliste et un autre meilleur sur une tâche : pour chaque
// domaine, le modèle testé qui devance strictement tous les autres (pas de badge à égalité).
function domainLeaders() {
  const tested = Object.keys(state.profiles ?? {}).filter((id) => state.models[id]?.installedAt && iqResult(id) && modelOf(id));
  const leaders = {};
  if (tested.length < 2) return leaders;
  for (const [key, label] of CATS) {
    const ranked = tested.map((id) => [id, iqResult(id).categories[key]?.points ?? 0]).sort((a, b) => b[1] - a[1]);
    if (ranked[0][1] > ranked[1][1]) (leaders[ranked[0][0]] ??= []).push(label);
  }
  return leaders;
}
function domainStrip(id) {
  const iq = iqResult(id);
  if (!iq) return '';
  return `<div class="domains" title="Banc d’intelligence par domaine (le poids dans la note entre parenthèses)">${CATS.map(([key, label, weight]) => {
    const points = iq.categories[key]?.points ?? 0;
    return `<div class="dom" title="${label} (${weight} %) : ${points}/100"><div class="top"><span>${label}</span><b>${points}</b></div><div class="bar"><i style="width:${points}%"></i></div></div>`;
  }).join('')}</div>`;
}
const clientOf = (ua = '') => (/^pi/i.test(ua) ? 'pi agent' : ua.includes('harn') ? 'Harn' : ua.split(/[/ (]/)[0] || 'client');

const icon = {
  heart: '<svg viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M8 13.8S1.8 10.2 1.8 5.9A3.2 3.2 0 0 1 8 4.4a3.2 3.2 0 0 1 6.2 1.5C14.2 10.2 8 13.8 8 13.8z"/></svg>',
  eye: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
  trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5"/></svg>',
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  cross: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  minus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 8h8"/></svg>',
  terminal: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="15" height="13" rx="2.5"/><path d="M6 8l2.5 2L6 12M10.5 12.5h3.5"/></svg>',
  power: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 2.8v6.4"/><path d="M5.6 5.4a6.5 6.5 0 1 0 8.8 0"/></svg>',
  copy: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/></svg>',
  bolt: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M11.3 1.8 3.8 11.2h5l-1 7 7.4-9.4h-5z"/></svg>',
  alert: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3 2.5 16.5h15z"/><path d="M10 8.5v3.5M10 14.5v.01"/></svg>',
  info: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v4.5M10 6.5v.01"/></svg>',
};

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}
async function copy(text, message) {
  try { await navigator.clipboard.writeText(text); toast(message); } catch { toast(text); }
}
async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Erreur ${response.status}`);
  return payload;
}

const regions = new Map();
function paint(id, html) {
  const el = document.getElementById(id);
  if (!el || regions.get(id) === html) return;
  regions.set(id, html);
  el.innerHTML = html;
}
function mount(name, html) {
  if (app.dataset.view === name) return false;
  app.dataset.view = name;
  regions.clear();
  app.innerHTML = html;
  return true;
}

function downloadsFor(prefix) {
  return Object.entries(state.downloads ?? {}).filter(([id]) => id.startsWith(prefix)).map(([, d]) => d);
}
function progressBlock(items) {
  if (!items.length) return '';
  return `<div class="progress">${items.map((d) => {
    const pct = d.total ? Math.min(100, (d.received / d.total) * 100) : 0;
    const eta = d.speed > 0 && d.total ? (d.total - d.received) / d.speed : null;
    const right = d.done ? 'terminé' : d.paused ? 'en pause' : `${d.speed ? rate(d.speed) : '…'}${eta ? ` · reste ${duration(eta)}` : ''}`;
    return `<div class="file-row"><div class="name">${esc(d.label)}</div>
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="progress-meta"><span class="num">${d.total ? `${gb(d.received)} / ${gb(d.total)}` : gb(d.received)}</span><span>${right}</span></div></div>`;
  }).join('')}</div>`;
}

// L'avancement d'une installation : les quatre étapes, la courante en avant, et ce qu'elle fait.
const PHASES = [
  ['download', 'Téléchargement', 'Téléchargement des fichiers'],
  ['tune', 'Réglages', 'Recherche des meilleurs réglages'],
  ['iq', 'Intelligence', 'Test de l’intelligence'],
  ['analysis', 'Analyse', 'Analyse des mesures par l’IA locale'],
];
function phaseBlock(id) {
  const entry = state.models[id] ?? {};
  const phase = entry.phase ?? (entry.installing ? 'download' : entry.tuning ? 'tune' : null);
  if (!phase) return '';
  const current = PHASES.findIndex(([key]) => key === phase);
  const model = modelOf(id);
  let detail = '';
  if (phase === 'download') {
    const items = downloadsFor(`model:${id}`).concat(model?.engine === 'strata' ? downloadsFor('runtime:strata') : []).filter((d) => !d.done);
    detail = progressBlock(items) || `<span class="phase-detail">${esc(entry.phaseDetail ?? entry.detail ?? 'Préparation…')}</span>`;
  } else {
    const text = phase === 'tune' ? (entry.tuneDetail ?? 'Chargement du modèle') : phase === 'iq' ? (state.profiles[id]?.iqRunning ?? 'Préparation') : 'L’IA locale relit ses mesures et l’écrit dans le carnet';
    detail = `<span class="phase-detail">${esc(text)}</span>`;
  }
  return `<div class="phases">
    <ol>${PHASES.map(([, short], i) => `<li class="${i < current ? 'done' : i === current ? 'now' : ''}">${i < current ? icon.check : `<b>${i + 1}</b>`}${short}</li>`).join('')}</ol>
    <div class="phase-now"><span class="dot"></span>Étape ${current + 1}/4 · ${PHASES[current][2]}</div>
    ${detail}
  </div>`;
}

const STAGE = { 'Départ': 'Point de départ', 'Spéculation MTP': 'Anticipation', 'DFlash2': 'Brouillon', 'KV en profondeur': 'Mémoire de contexte', 'Flash Attention': 'Attention', 'Backend': 'Moteur', 'Strata': 'Strata', 'Réglages Strata': 'Point de départ' };
const stageOf = (arm) => STAGE[arm.stage] ?? arm.stage ?? '';

// Les réglages en mots simples ; le libellé technique reste visible en second plan.
function plainArm(arm) {
  const label = arm.label ?? '';
  const mtp = label.match(/MTP(\d)/);
  if (arm.stage === 'KV en profondeur') {
    const kv = label.match(/KV (\S+)/)?.[1];
    return `Mémoire de contexte ${kv === 'f16' ? '16' : kv === 'q4_0' ? '4' : '8'} bits`;
  }
  if (/DFlash2/.test(label)) return 'Brouillon DFlash2';
  if (arm.stage === 'Flash Attention') return 'Sans Flash Attention';
  if (arm.stage === 'Backend') return `Moteur ${label.split(' · ').pop()}`;
  if (mtp) return `Anticipe ${mtp[1]} token${mtp[1] > 1 ? 's' : ''}`;
  return label;
}

// ── Markdown minimal pour le carnet ────────────────────────
function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => (/^https?:/.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : t));
}
function markdown(source) {
  const lines = source.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) { const level = Math.min(3, heading[1].length); out.push(`<h${level}>${inline(heading[2])}</h${level}>`); i += 1; continue; }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) { rows.push(lines[i]); i += 1; }
      const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((row, n) => n !== 1 || !/^[\s|:-]+$/.test(row));
      out.push(`<div class="table"><table><thead><tr>${cells(body[0]).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.slice(1).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s/, '')); i += 1; }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (line.startsWith('>')) {
      const quote = [];
      while (i < lines.length && lines[i].startsWith('>')) { quote.push(lines[i].replace(/^>\s?/, '')); i += 1; }
      out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\||>|\s*([-*]|\d+\.)\s)/.test(lines[i])) { para.push(lines[i]); i += 1; }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('');
}

// ── Apparence ──────────────────────────────────────────────
const themes = window.HarnThemes;
const css = (font) => String(font).replaceAll('"', "'");

function themePicker() {
  const base = themes.THEMES.signal.fonts;
  const card = ([id, theme]) => {
    const p = themes.preview(id);
    const f = { ...base, ...theme.fonts };
    return `<button class="skin ${themes.skin === id ? 'on' : ''}" data-skin="${id}" style="background:${p.surface};color:${p.text};border-color:${p.line}">
      <span class="aa" style="font-family:${css(f.display)};font-weight:${f.weight};letter-spacing:${f.tracking}">Aa <span style="font-family:${css(f.figures)};color:${p.signal}">76</span></span>
      <span class="meta"><span class="name" style="font-family:${css(f.sans)}">${esc(theme.name)}</span><span class="dots"><i style="background:${p.signal}"></i><i style="background:${p.violet}"></i><i style="background:${p.bg}"></i></span></span>
      <span class="note" style="font-family:${css(f.sans)};color:${p.muted}">${esc(theme.note)}</span>
    </button>`;
  };
  const family = (group) => Object.entries(themes.THEMES).filter(([, theme]) => theme.group === group).map(card).join('');
  const modeLabel = { auto: 'automatique (suit Windows)', light: 'clair', dark: 'sombre' }[themes.mode];
  return `<div class="picker">
    <div class="skins-group"><span class="label">Terminaux · tons chauds</span><span>bruns, verts, ors</span></div><div class="skins">${family('chaud')}</div>
    <div class="skins-group"><span class="label">Terminaux · tons froids</span><span>bleus, violets</span></div><div class="skins">${family('froid')}</div>
    <div class="skins-group"><span class="label">Expressifs</span><span>plus marqués</span></div><div class="skins">${family('expressif')}</div>
    <div class="skins-foot"><span>Mode ${modeLabel}. Chaque thème existe en clair et en sombre.</span></div></div>`;
}

const pop = document.getElementById('theme-pop');
const MODE_ICON = {
  light: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.6"/><path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3 6 14M14 6l1.3-1.3"/></svg>',
  dark: '<svg viewBox="0 0 20 20"><path d="M16.2 12.6A6.8 6.8 0 0 1 7.4 3.8a6.8 6.8 0 1 0 8.8 8.8z"/></svg>',
  auto: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/><path d="M10 3a7 7 0 0 0 0 14z" class="fill"/></svg>',
};
const MODE_TITLE = { light: 'Mode clair · passer en sombre', dark: 'Mode sombre · passer en automatique', auto: 'Mode automatique (suit Windows) · passer en clair ou sombre' };

// La barre de préférences : thème, mode clair/sombre, taille du texte.
function renderPrefs() {
  const modeButton = document.getElementById('pref-mode');
  modeButton.innerHTML = MODE_ICON[themes.mode];
  modeButton.title = MODE_TITLE[themes.mode];
  modeButton.setAttribute('aria-label', MODE_TITLE[themes.mode]);
  document.getElementById('pref-scale').textContent = `${Math.round(themes.scale * 100)} %`;
  document.getElementById('pref-smaller').disabled = !themes.canShrink;
  document.getElementById('pref-larger').disabled = !themes.canGrow;
  document.getElementById('pref-theme').classList.toggle('on', !pop.hidden);
}
document.getElementById('pref-theme').addEventListener('click', (event) => {
  event.stopPropagation();
  themes.loadAllFonts();
  pop.innerHTML = themePicker();
  pop.hidden = !pop.hidden;
  renderPrefs();
});
document.getElementById('pref-mode').addEventListener('click', () => themes.cycleMode());
document.getElementById('pref-smaller').addEventListener('click', () => themes.setScale(-1));
document.getElementById('pref-larger').addEventListener('click', () => themes.setScale(1));
document.getElementById('pref-scale').addEventListener('click', () => themes.setScale(0));
document.addEventListener('click', (event) => {
  const skin = event.target.closest('[data-skin]');
  const mode = event.target.closest('[data-mode]');
  if (skin) return themes.apply(skin.dataset.skin, themes.mode);
  if (mode) return themes.apply(themes.skin, mode.dataset.mode);
  if (!pop.hidden && !pop.contains(event.target)) { pop.hidden = true; renderPrefs(); }
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !pop.hidden) { pop.hidden = true; renderPrefs(); } });
window.addEventListener('harn:theme', () => {
  renderPrefs();
  if (!pop.hidden) pop.innerHTML = themePicker();
  // La jauge et le graphique ont des tracés calculés : on les redessine dans le nouveau thème.
  if (view === 'home') { regions.clear(); render(); }
});
renderPrefs();

// ── Barre latérale ─────────────────────────────────────────
function renderShell() {
  const onboarding = view === 'onboard';
  document.body.classList.toggle('onboarding', onboarding);
  for (const button of navEl.querySelectorAll('button')) {
    button.classList.toggle('on', button.dataset.view === view);
    const upgrade = state.plan?.upgradeModel && !state.models[state.plan.upgradeModel]?.installedAt;
    if (button.dataset.view === 'models') {
      const badge = button.querySelector('.count');
      if (upgrade && !badge) button.insertAdjacentHTML('beforeend', '<span class="count">1</span>');
      if (!upgrade && badge) badge.remove();
    }
  }
  const active = state.active;
  let dot = '';
  let text = '';
  if (state.setup.phase === 'running') { dot = 'busy'; text = '<b>Installation</b>en cours'; }
  else if (!active) text = '<b>Aucun modèle</b>chargé';
  else if (active.status === 'loading') { dot = 'busy'; text = `<b>Chargement</b>${esc(nameOf(active.modelId))}`; }
  else if (active.status === 'ready') { dot = 'ready'; text = `<b>${esc(nameOf(active.modelId))}</b>prêt · ${esc(modelOf(active.modelId)?.variant ?? '')}`; }
  else if (['crashed', 'error'].includes(active.status)) { dot = 'error'; text = `<b>Moteur arrêté</b>${esc(active.error ?? '')}`; }
  else text = `<b>${esc(nameOf(active.modelId))}</b>en pause · carte libérée`;
  const html = `<span class="dot ${dot}"></span><span>${text}</span>`;
  if (statusEl.innerHTML !== html) statusEl.innerHTML = html;
}

// ── Accueil ────────────────────────────────────────────────
const G = { cx: 100, cy: 100, r: 80, start: 135, sweep: 270 };
const polar = (deg, r = G.r) => [G.cx + r * Math.cos((deg * Math.PI) / 180), G.cy + r * Math.sin((deg * Math.PI) / 180)];
function arc(from, to) {
  const [x1, y1] = polar(G.start + G.sweep * from);
  const [x2, y2] = polar(G.start + G.sweep * to);
  const large = G.sweep * (to - from) > 180 ? 1 : 0;
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${G.r} ${G.r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

function homeSkeleton() {
  mount('home', `<div class="view">
    <section class="card hero">
      <div id="hero-info"></div>
      <div class="gauge" id="gauge">
        <svg viewBox="0 0 200 190" aria-hidden="true">
          <path class="track" d="${arc(0, 1)}"/>
          <path class="slow" id="gauge-slow"/>
          <path class="value idle" id="gauge-value" d="${arc(0, 1)}" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/>
          <g id="gauge-tick"></g>
        </svg>
        <div class="center"><div class="big num" id="gauge-num">—</div><div class="unit">tok/s</div><div class="mode" id="gauge-mode"></div></div>
      </div>
    </section>
    <div class="tiles" id="tiles"></div>
    <div id="next"></div>
    <section class="card activity" id="activity">
      <div class="main"><div id="act-head"></div><div id="act-spark"></div><div id="act-stats"></div><div id="act-req"></div></div>
      <div class="gpu" id="act-gpu"></div>
    </section>
  </div>`);
}

function renderHero() {
  const active = state.active;
  const model = active ? modelOf(active.modelId) : null;
  const profile = active ? state.profiles[active.modelId] ?? {} : {};
  const ready = active?.status === 'ready';
  const loading = active?.status === 'loading';
  const paused = active && !ready && !loading;
  const dotClass = ready ? '' : loading ? 'busy' : 'off';
  const eyebrow = ready ? 'Votre IA locale est prête' : loading ? 'Chargement du modèle…' : paused ? 'IA en pause · carte graphique libérée' : 'Aucune IA chargée';
  const tuning = profile.tuning;
  const note = tuning ? `${kTokens(tuning.context)} de contexte · ${plainArm({ label: profile.bench?.winner?.label ?? '' }) || 'réglage par défaut'} · ${esc(state.plan?.backend?.label ?? '')}` : '';
  paint('hero-info', `
    <div class="eyebrow"><span class="dot ${dotClass}"></span>${eyebrow}</div>
    <h1>${esc(model?.name ?? 'Harn')}</h1>
    <div class="variant">${esc(model?.variant ?? '')}</div>
    <div class="actions">
      <button class="btn signal big" data-action="pi" ${!state.pi.installed || loading ? 'disabled' : ''}>${icon.terminal} Tester dans pi agent</button>
      <button class="btn big" data-action="copy-api">${icon.copy} Brancher une application</button>
      ${ready || loading
        ? `<button class="btn big ghost" data-action="unload" title="Arrête le modèle et rend toute la mémoire graphique">${icon.power} Libérer la carte graphique</button>`
        : paused ? `<button class="btn big primary" data-action="activate" data-id="${active.modelId}">${icon.power} Recharger l’IA</button>` : ''}
    </div>
    ${paused ? '<p class="note">La carte graphique est libre. pi agent ou une autre application rechargera le modèle tout seul à sa prochaine requête.</p>' : ''}
    ${note ? `<p class="note">${note}</p>` : ''}`);
}

function renderGauge() {
  const active = state.active;
  const request = live?.request;
  const benchTps = active ? state.profiles[active.modelId]?.bench?.winner?.tps : null;
  let value = benchTps ?? null;
  let mode = benchTps ? 'mesuré ici' : 'pas encore mesuré';
  let cls = 'value';
  if (request?.phase === 'prefill') { mode = 'lecture du prompt…'; }
  if (request?.phase === 'decode' && request.tps) { value = request.tps; mode = 'en direct'; }
  const paused = active && !['ready', 'loading'].includes(active.status);
  if (paused) { mode = 'en pause'; value = null; }
  if (!value) cls += ' idle';
  const max = Math.max(100, Math.ceil(((Math.max(value ?? 0, benchTps ?? 0)) * 1.25) / 20) * 20);
  const goal = (state.plan?.objective?.minTps ?? 40) / max;
  if (value && value < (state.plan?.objective?.minTps ?? 40)) cls += ' under';
  const pct = value ? Math.min(100, (value / max) * 100) : 0;
  const el = document.getElementById('gauge-value');
  if (!el) return;
  el.setAttribute('class', cls);
  el.setAttribute('stroke-dashoffset', String(100 - pct));
  document.getElementById('gauge-slow').setAttribute('d', arc(0, goal));
  const [x1, y1] = polar(G.start + G.sweep * goal, G.r - 13);
  const [x2, y2] = polar(G.start + G.sweep * goal, G.r + 13);
  const [lx, ly] = polar(G.start + G.sweep * goal, G.r + 25);
  document.getElementById('gauge-tick').innerHTML = `<line class="tick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/><text class="tick-label" x="${lx}" y="${ly + 3}" text-anchor="middle">40</text>`;
  document.getElementById('gauge-num').textContent = value ? fr(value) : '—';
  document.getElementById('gauge-mode').textContent = mode;
}

function tile({ label, ok, value, unit, sub, target, meter }) {
  return `<div class="card tile">
    <div class="head"><span class="label">${label}</span><span class="check ${ok === false ? 'no' : ''}">${ok === null ? icon.minus : ok ? icon.check : icon.alert}</span></div>
    <div class="v">${value}${unit ? `<small>${unit}</small>` : ''}</div>
    <div class="sub">${sub}</div>
    ${meter}
    <div class="target">${target}</div>
  </div>`;
}

function renderTiles() {
  const id = state.active?.modelId;
  if (!id) { paint('tiles', ''); return; }
  const objective = state.plan?.objective ?? { minContext: 102400, maxContext: 153600, minTps: 40 };
  const profile = state.profiles[id] ?? {};
  const model = modelOf(id);
  const tps = profile.bench?.winner?.tps ?? null;
  const usage = profile.usage?.seconds ? profile.usage.tokens / profile.usage.seconds : null;
  const context = profile.tuning?.context ?? verdictOf(id)?.context ?? null;
  const target = modelOf(state.plan?.targetModel);
  const mine = iqOf(id);
  const best = target ? iqOf(target.id) : mine;
  const speedMax = Math.max(120, (tps ?? 0) * 1.2);
  const words = context ? Math.round((context * 0.75) / 1000) * 1000 : 0;
  paint('tiles', [
    tile({
      label: 'Vitesse',
      ok: tps === null ? null : tps >= objective.minTps,
      value: tps ? fr(tps) : '—',
      unit: 'tok/s',
      sub: usage ? `${fr(usage)} tok/s en moyenne à l’usage` : 'mesurée sur votre carte',
      meter: `<div class="meter"><i style="width:${Math.min(100, ((tps ?? 0) / speedMax) * 100)}%"></i><b style="left:${(objective.minTps / speedMax) * 100}%"></b></div>`,
      target: `Objectif : ${objective.minTps} tok/s minimum`,
    }),
    tile({
      label: 'Mémoire de travail',
      ok: context === null ? null : context >= objective.minContext,
      value: context ? kTokens(context) : '—',
      unit: 'tokens',
      sub: context ? `≈ ${fr(words)} mots, ${fr(Math.round(words / 400))} pages` : '',
      meter: `<div class="meter"><span style="left:${(objective.minContext / 163840) * 100}%;width:${((objective.maxContext - objective.minContext) / 163840) * 100}%"></span><i style="width:${Math.min(100, ((context ?? 0) / 163840) * 100)}%"></i></div>`,
      target: `Objectif : ${kTokens(objective.minContext)} à ${kTokens(objective.maxContext)}`,
    }),
    tile({
      label: 'Intelligence',
      ok: (best.value ?? 0) <= (mine.value ?? 0),
      value: mine.value ?? '—',
      unit: mine.tested ? '/100' : '/100 estimée',
      sub: (best.value ?? 0) > (mine.value ?? 0) ? `Jusqu’à ${best.value} possible sur cette machine` : 'Le plus fort possible sur cette machine',
      meter: `<div class="meter"><i style="width:${mine.value ?? 0}%"></i>${(best.value ?? 0) > (mine.value ?? 0) ? `<b style="left:${best.value}%"></b>` : ''}</div>`,
      target: mine.tested ? 'Banc d’intelligence Harn' : 'À confirmer par le banc d’intelligence (Réglages)',
    }),
  ].join(''));
}

function renderNext() {
  const plan = state.plan;
  const id = plan?.upgradeModel;
  const entry = id ? state.models[id] ?? {} : {};
  if (id && !entry.installedAt) {
    const model = modelOf(id);
    const verdict = verdictOf(id);
    const current = modelOf(state.active?.modelId);
    let side = `<button class="btn violet big" data-action="install" data-id="${id}">${icon.bolt} Installer et régler</button><small>${gb(model.totalBytes)} · en arrière-plan, votre IA reste disponible</small>`;
    if (entry.phase || entry.installing || entry.tuning) side = phaseBlock(id);
    paint('next', `<section class="card next">
      <div>
        <div class="label">Prochaine étape</div>
        <h2>Une IA plus forte tient sur votre machine</h2>
        <p>${esc(model.name)} · ${esc(model.variant)}. ${esc(model.tagline)}</p>
        ${whyTarget(id)}
        <div class="facts">
          ${ratingFact(id)}
          <div class="fact"><b>${iqOf(id).value ?? '?'}${current ? ` <span style="color:var(--faint);font-weight:400">vs ${iqOf(current.id).value ?? '?'}</span>` : ''}</b>intelligence${iqOf(id).tested ? '' : ' (estimée)'}</div>
          <div class="fact"><b>~${verdict?.tps ?? '?'} tok/s</b>estimés à 100k</div>
          <div class="fact"><b>${verdict?.context ? kTokens(verdict.context) : '—'}</b>de contexte</div>
        </div>
        ${entry.error ? `<p style="color:var(--danger)">${esc(entry.error)}</p>` : ''}
      </div>
      <div class="side-action">${side}</div>
    </section>`);
    return;
  }
  // Le meilleur modèle est déjà installé mais pas utilisé : on le propose aussi.
  const best = plan?.targetModel;
  if (best && state.models[best]?.installedAt && state.active?.modelId !== best) {
    const model = modelOf(best);
    const verdict = verdictOf(best);
    const current = modelOf(state.active?.modelId);
    const bench = state.profiles[best]?.bench?.winner;
    paint('next', `<section class="card next">
      <div>
        <div class="label">Prochaine étape</div>
        <h2>Un meilleur modèle est déjà installé</h2>
        <p>${esc(model.name)} · ${esc(model.variant)}. Il fait mieux que le modèle actuel sur votre machine.</p>
        ${whyTarget(best)}
        <div class="facts">
          ${ratingFact(best)}
          <div class="fact"><b>${iqOf(best).value ?? '?'}${current ? ` <span style="color:var(--faint);font-weight:400">vs ${iqOf(current.id).value ?? '?'}</span>` : ''}</b>intelligence</div>
          <div class="fact"><b>${bench ? fr(bench.tps) : '~' + (verdict?.tps ?? '?')} tok/s</b>${bench ? 'mesurés ici' : 'estimés'}</div>
          <div class="fact"><b>${verdict?.context ? kTokens(verdict.context) : '—'}</b>de contexte</div>
        </div>
      </div>
      <div class="side-action"><button class="btn violet big" data-action="activate" data-id="${best}">Utiliser ce modèle</button><small>Chargement en quelques secondes</small></div>
    </section>`);
    return;
  }
  paint('next', plan?.advice ? `<div class="tip">${icon.info}<span><b>Pour aller plus loin.</b> ${esc(plan.advice)}</span></div>` : '');
}

function sparkline(series) {
  const points = series.slice(-120);
  const goal = state.plan?.objective?.minTps ?? 40;
  const max = Math.max(goal * 2, ...points.map((p) => p.tps)) * 1.12;
  const w = 600;
  const h = 110;
  const gy = h - 2 - (goal / max) * (h - 10);
  const defs = '<defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".28"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>';
  const frame = `<line class="base" x1="0" x2="${w}" y1="${h - 1}" y2="${h - 1}"/><line class="goal" x1="0" x2="${w}" y1="${gy}" y2="${gy}"/>`;
  if (points.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="color:var(--signal)">${defs}${frame}</svg>`;
  const step = w / 119;
  const offset = (120 - points.length) * step;
  const coords = points.map((p, i) => [offset + i * step, h - 2 - (p.tps / max) * (h - 10)]);
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const area = `${line}L${coords.at(-1)[0].toFixed(1)},${h}L${coords[0][0].toFixed(1)},${h}Z`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="color:var(--signal)" role="img" aria-label="Débit des deux dernières minutes">${defs}${frame}<path class="area" d="${area}"/><path class="line" d="${line}"/></svg>`;
}

function renderActivity() {
  const request = live?.request;
  const last = live?.recent?.[0];
  const phase = request?.phase ?? 'idle';
  const pill = { idle: 'Au repos', prefill: 'Lecture du prompt', decode: 'Génération' }[phase];
  paint('act-head', `<div class="top"><span class="label">Activité</span><span class="pill ${phase}"><span class="dot"></span>${pill}${request ? ` · ${esc(request.key ?? clientOf(request.client))}` : ''}</span></div>`);
  paint('act-spark', `${sparkline(live?.series ?? [])}<div class="spark-legend"><span>il y a 2 min</span><span>— — objectif 40 tok/s</span><span>maintenant</span></div>`);
  const ttft = request?.ttft ?? last?.ttft;
  const tokens = request ? request.decoded : last?.generated;
  const prefill = request ? null : last?.prefillTps;
  const accept = request ? null : last?.draftAcceptance;
  paint('act-stats', `<div class="stats">
    <div class="stat"><div class="k">Premier token</div><div class="v">${ttft ? fr(ttft, ttft < 10 ? 1 : 0) : '—'}<small>s</small></div></div>
    <div class="stat"><div class="k">Tokens générés</div><div class="v">${tokens ? fr(tokens) : '—'}</div></div>
    <div class="stat"><div class="k">Lecture du prompt</div><div class="v">${prefill ? fr(prefill) : '—'}<small>tok/s</small></div></div>
    <div class="stat"><div class="k">Anticipations réussies</div><div class="v">${accept ? fr(accept * 100) : '—'}<small>%</small></div></div>
  </div>`);
  const recent = live?.recent ?? [];
  paint('act-req', recent.length
    ? `<ul class="requests">${recent.slice(0, 5).map((r) => `<li><span class="when">${clock(r.at)}</span><span class="what">${esc(r.key ?? clientOf(r.client))} · ${fr(r.generated ?? 0)} tokens${r.ttft ? ` · 1er token ${fr(r.ttft, 1)} s` : ''}${r.error ? ` · ${esc(r.error)}` : ''}</span><span class="tps">${r.tps ? `${fr(r.tps)} tok/s` : '—'}</span></li>`).join('')}</ul>`
    : '<p class="empty" style="margin-top:14px">Aucune requête pour l’instant. Ouvrez pi agent et donnez-lui une tâche : le débit s’affiche ici en direct.</p>');

  const gpu = live?.gpu;
  const name = state.hardware?.primary?.name?.replace(/NVIDIA GeForce |AMD Radeon /, '') ?? 'Processeur';
  if (!gpu) { paint('act-gpu', `<div class="name">${esc(name)}</div><p class="empty">${fr(state.hardware?.ramGiB ?? 0)} Go de RAM</p>`); return; }
  const tight = gpu.freeMiB < 1536 && state.active?.status === 'ready';
  const throttled = request?.phase === 'decode' && /P([3-9])/.test(gpu.pstate);
  paint('act-gpu', `
    <div class="name"><span>${esc(name)}</span><span class="tag">${esc(gpu.pstate)}</span></div>
    <div class="gpu-row"><div class="top"><span>Utilisation</span><b>${gpu.util} %</b></div><div class="bar"><i style="width:${gpu.util}%"></i></div></div>
    <div class="gpu-row vram ${tight ? 'tight' : ''}"><div class="top"><span>Mémoire graphique</span><b>${fr(gpu.usedMiB / 1024, 1)} / ${fr(gpu.totalMiB / 1024)} Go</b></div><div class="bar"><i style="width:${((gpu.usedMiB / gpu.totalMiB) * 100).toFixed(1)}%"></i></div></div>
    <div class="gpu-meta"><div><b>${fr(gpu.freeMiB / 1024, 1)} Go</b>libres</div><div><b>${gpu.tempC} °C</b>température</div><div><b>${gpu.powerW ? `${fr(gpu.powerW)} W` : '—'}</b>puissance</div><div><b>${fr(gpu.smMHz)}</b>MHz</div></div>
    ${tight ? '<div class="warn-line">Moins de 1,5 Go libre : les longs prompts peuvent ralentir fortement.</div>' : ''}
    ${throttled ? '<div class="warn-line">La carte s’est mise en économie d’énergie pendant la génération.</div>' : ''}`);
}

function renderHome() {
  homeSkeleton();
  renderHero();
  renderGauge();
  renderTiles();
  renderNext();
  renderActivity();
}

// ── Modèles ────────────────────────────────────────────────
function modelCard(model) {
  const verdict = verdictOf(model.id) ?? { fit: 'no', reasons: [] };
  const entry = state.models[model.id] ?? {};
  const isActive = state.active?.modelId === model.id;
  const loading = isActive && state.active.status === 'loading';
  const profile = state.profiles[model.id] ?? {};
  const measured = profile.bench?.winner?.tps;
  const isUpgrade = state.plan?.upgradeModel === model.id && !entry.installedAt;
  const isTarget = state.plan?.targetModel === model.id;
  const off = verdict.fit === 'no' && !entry.installedAt;
  const minTps = state.plan?.objective?.minTps ?? 40;

  const badges = [];
  if (isActive) badges.push(state.active.status === 'ready' || loading ? `<span class="badge active">${loading ? 'Chargement…' : 'Actif'}</span>` : '<span class="badge">En pause</span>');
  else if (entry.installedAt) badges.push('<span class="badge">Installé</span>');
  if (isUpgrade) badges.push('<span class="badge upgrade">Recommandé pour vous</span>');
  else if (isTarget && !isActive) badges.push('<span class="badge upgrade" title="Meilleure note globale parmi les modèles qui tiennent 100k de contexte et 40 tok/s">Meilleur choix ici</span>');
  if (model.engine === 'strata') badges.push('<span class="badge">Grand MoE · Strata</span>');
  if (model.vision) badges.push(`<span class="badge icon" title="Vision : comprend les images" aria-label="Vision : comprend les images">${icon.eye}</span>`);
  if (verdict.fit === 'partial' && !entry.installedAt) badges.push('<span class="badge warn">En partie sur le processeur</span>');
  for (const label of domainLeaders()[model.id] ?? []) badges.push(`<span class="badge lead" title="Meilleure note du banc d’intelligence en ${label.toLowerCase()} parmi vos modèles testés">Meilleur en ${label.toLowerCase()}</span>`);
  if (iqResult(model.id)?.verbosity.label === 'bavard') badges.push('<span class="badge warn" title="Réfléchit longtemps avant de répondre">Bavard</span>');

  const speed = measured
    ? `<div class="v ${measured < minTps ? 'bad' : ''}">${fr(measured)}<small>tok/s</small></div>`
    : verdict.tps ? `<div class="v est ${verdict.tps < minTps ? 'bad' : ''}">~${verdict.tps}<small>estimé</small></div>` : '<div class="v est">—</div>';

  let action = '';
  if (entry.phase || entry.installing || entry.tuning) action = `<div style="width:100%">${phaseBlock(model.id)}</div>`;
  else if (isActive && state.active.status === 'ready') action = `<button class="btn" data-action="view" data-id="tuning">Voir le réglage</button><button class="btn ghost" data-action="unload">${icon.power} Libérer la carte</button>`;
  else if (isActive && !loading) action = `<button class="btn primary" data-action="activate" data-id="${model.id}">${icon.power} Recharger</button>`;
  else if (entry.installedAt) action = `<button class="btn primary" data-action="activate" data-id="${model.id}">Utiliser ce modèle</button>`;
  // Le banc d'intelligence se lance depuis la carte : le modèle est chargé si besoin.
  const iqRun = state.profiles[model.id]?.iqRunning;
  if (entry.installedAt && !entry.phase && !entry.installing && !entry.tuning) action += `<button class="btn ghost" data-action="iq" data-id="${model.id}" ${iqRun ? 'disabled' : ''} title="${iqRun ? esc(iqRun) : 'Une à deux minutes, le modèle est chargé si besoin'}">${iqRun ? 'Banc en cours…' : iqResult(model.id) ? 'Retester l’intelligence' : 'Tester l’intelligence'}</button>`;
  else if (!off) action = `<button class="btn ${isUpgrade ? 'violet' : ''}" data-action="install" data-id="${model.id}">${icon.bolt} Installer et régler</button>`;

  return `<article class="card model ${isActive ? 'active' : ''} ${isUpgrade ? 'upgrade' : ''} ${off ? 'off' : ''}">
    ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
    <div class="title-row"><div><h3>${esc(model.name)}</h3><div class="variant">${esc(model.variant)}</div>${entry.installedAt ? `<button class="model-id" data-action="copy-text" data-text="${esc(model.id)}" title="Le nom à mettre dans le champ « model » de votre application · cliquer pour copier">${icon.copy}<span>${esc(model.id)}</span></button>` : ''}</div>${entry.installedAt ? `<button class="heart ${state.favorite === model.id ? 'on' : ''}" data-action="favorite" data-id="${model.id}" title="${state.favorite === model.id ? 'Modèle par défaut · cliquer pour retirer' : 'En faire le modèle par défaut'}" aria-pressed="${state.favorite === model.id}">${icon.heart}</button>` : ''}</div>
    <p class="tagline">${esc(model.tagline)}</p>
    <div class="facts">
      <div title="Nombre de paramètres${moeOf(model) ? ' (tous les experts du MoE)' : ''}"><div class="k">Taille</div>${model.paramsB ? `<div class="v">${fr(model.paramsB, model.paramsB % 1 ? 1 : 0)}B${moeOf(model) ? '<small>MoE</small>' : ''}</div>` : '<div class="v est">—</div>'}</div>
      <div><div class="k">Intelligence</div>${iqOf(model.id).value != null ? `<div class="v ${iqOf(model.id).tested ? '' : 'est'}">${iqOf(model.id).tested ? '' : '~'}${iqOf(model.id).value}<small>${iqOf(model.id).tested ? '/100' : 'estimée'}</small></div>` : '<div class="v est">à tester</div>'}</div>
      <div><div class="k">Vitesse ici</div>${speed}</div>
      <div><div class="k">Contexte ici</div><div class="v ${verdict.context && verdict.context < 102400 ? 'bad' : ''}">${verdict.context ? kTokens(verdict.context) : '—'}</div></div>
      <div title="Intelligence 40 % · taille 25 % · vitesse 20 % · contexte 15 %"><div class="k">Note globale</div>${verdict.rating != null ? `<div class="v ${verdict.ratingMeasured ? '' : 'est'}">${verdict.ratingMeasured ? '' : '~'}${verdict.rating}<small>${verdict.ratingMeasured ? '/100' : 'estimée'}</small></div>` : '<div class="v est">—</div>'}</div>
    </div>
    ${domainStrip(model.id)}
    ${isTarget ? whyTarget(model.id) : ''}
    ${off ? `<p class="why">Pas pour cette machine : ${esc(verdict.reasons.join(', '))}.</p>` : ''}
    ${entry.installing && entry.detail ? `<p class="why">${esc(entry.detail)}</p>` : ''}
    ${entry.error ? `<div class="install-error"><p>${esc(entry.error)}</p><div class="row">
        <button class="btn small" data-action="open-log" data-id="${model.id}">Voir le journal</button>
        <button class="btn small" data-action="retry" data-id="${model.id}">Réessayer</button>
        ${helperFor(model.id) ? `<button class="btn small primary" data-action="ask-pi" data-id="${model.id}" title="pi dépanne avec ${esc(nameOf(helperFor(model.id)))}">${icon.terminal} Demander à pi</button>` : ''}
      </div></div>` : ''}
    <div class="foot">${action}${(entry.installedAt || entry.error) && !entry.installing && !entry.tuning && !loading ? `<button class="btn ghost small" data-action="delete-model" data-id="${model.id}" title="Supprimer ses fichiers et ses réglages">${icon.trash} Supprimer</button>` : ''}<span class="size">${gb(model.totalBytes)}</span></div>
  </article>`;
}

// ── Veille Hugging Face ────────────────────────────────────
const daysAgo = (iso) => { const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000); return d <= 0 ? 'aujourd’hui' : d === 1 ? 'hier' : `il y a ${d} jours`; };
function hubSection() {
  const w = state.watch ?? {};
  const items = (w.items ?? []).filter((i) => i.usable)
    .sort((a, b) => (b.best.meetsObjective - a.best.meetsObjective) || (b.likes - a.likes));
  const updates = w.updates ?? [];
  const head = `<div class="group-title hub-head"><h2>Nouveautés sur Hugging Face</h2><span>${w.checking ? 'recherche en cours…' : w.checkedAt ? `vérifié ${daysAgo(w.checkedAt)} à ${clock(w.checkedAt)}` : 'pas encore vérifié'}</span>
    <button class="btn small ghost" data-action="hub-check" ${w.checking ? 'disabled' : ''}>Vérifier maintenant</button></div>`;
  const upd = updates.map((u) => `<div class="tip">${icon.info}<span><b>${esc(nameOf(u.id))} a été mis à jour sur Hugging Face</b> (${esc(u.files.join(', '))}). Supprimez-le puis réinstallez-le pour en profiter. <a href="https://huggingface.co/${esc(u.repo)}" target="_blank" rel="noopener">Voir le dépôt</a></span></div>`).join('');
  const cards = items.map((i) => {
    const b = i.best;
    const tags = [i.moe ? 'MoE' : null, i.vision ? 'vision' : null, b.fit === 'partial' ? 'en partie sur le processeur' : null].filter(Boolean).join(' · ');
    return `<article class="card model hub">
      <div class="badges">${b.meetsObjective ? '<span class="badge upgrade" title="Tient 100k de contexte et 40 tok/s sur cette machine">Atteint l’objectif ici</span>' : ''}<span class="badge">♥ ${fr(i.likes)}</span><span class="badge">${daysAgo(i.lastModified ?? i.createdAt)}</span></div>
      <div class="title-row"><div><h3>${esc(i.name)}</h3><div class="variant">${esc(i.repo)}</div></div></div>
      <div class="facts">
        <div><div class="k">Taille</div><div class="v ${i.paramsB ? '' : 'est'}">${i.paramsB ? `${fr(i.paramsB, i.paramsB % 1 ? 1 : 0)}B` : '—'}</div></div>
        <div><div class="k">Version</div><div class="v" style="font-size:calc(13px * var(--fs))">${esc(b.quant)}</div></div>
        <div><div class="k">Vitesse ici</div><div class="v est">~${b.tps}<small>estimé</small></div></div>
        <div><div class="k">Contexte ici</div><div class="v ${b.context < 102400 ? 'bad' : ''}">${kTokens(b.context)}</div></div>
        <div><div class="k">Téléchargement</div><div class="v">${fr(b.gigabytes, 1)}<small>Go</small></div></div>
      </div>
      ${tags || i.license ? `<p class="why">${esc([tags, i.license ? `licence ${i.license}` : null].filter(Boolean).join(' · '))}</p>` : ''}
      <div class="foot"><button class="btn violet" data-action="hub-install" data-repo="${esc(i.repo)}" data-quant="${esc(b.quant)}" data-mmproj="${esc(i.mmproj ?? '')}">${icon.bolt} Installer et tester</button>
        <a class="btn ghost" href="https://huggingface.co/${esc(i.repo)}" target="_blank" rel="noopener">Voir</a>
        <button class="btn ghost small" data-action="hub-dismiss" data-repo="${esc(i.repo)}" title="Ne plus proposer ce modèle">Écarter</button></div>
    </article>`;
  }).join('');
  const empty = !items.length && !updates.length ? `<p class="empty">${w.error ? `Hugging Face n’a pas répondu : ${esc(w.error)}` : w.checkedAt ? 'Rien de nouveau ces 30 derniers jours qui tourne bien sur cette machine.' : 'Harn regarde une fois par jour les modèles sortis ou mis à jour sur Hugging Face, et ne garde que ceux qui tournent bien ici.'}</p>` : '';
  return `<div>${head}<div style="display:grid;gap:12px;margin-top:16px">${upd}${empty}${cards ? `<div class="models">${cards}</div>` : ''}</div></div>`;
}

function renderModels() {
  mount('models', `<div class="view">
    <div class="view-head"><div><h1>Modèles</h1><p>Pour chacun, ce que votre machine en tire : contexte qui tient sur la carte, vitesse attendue à 100k, intelligence.</p></div></div>
    <section class="card add-model">
      <div><h2>Ajouter un modèle depuis Hugging Face</h2><p>Collez l’adresse d’un dépôt GGUF. pi agent l’analyse pour votre carte, vous propose la meilleure version, puis Harn la télécharge, la règle et teste son intelligence.</p></div>
      <form class="add-form" data-form="add-model">
        <input id="hf-url" type="url" placeholder="https://huggingface.co/auteur/modele-GGUF" autocomplete="off" spellcheck="false" required>
        <button class="btn primary" type="submit">${icon.terminal} Installer avec pi</button>
      </form>
    </section>
    <div id="models-body"></div>
  </div>`);
  const mine = catalog.filter((m) => state.models[m.id]?.installedAt || state.active?.modelId === m.id);
  const upgrade = catalog.filter((m) => !mine.includes(m) && state.plan?.upgradeModel === m.id);
  const rest = catalog.filter((m) => !mine.includes(m) && !upgrade.includes(m)).sort((a, b) => b.quality - a.quality);
  const ok = rest.filter((m) => verdictOf(m.id)?.fit !== 'no');
  const no = rest.filter((m) => verdictOf(m.id)?.fit === 'no');
  const featured = [...mine.map((m) => ['Sur votre machine', m]), ...upgrade.map((m) => ['Recommandé pour vous', m])];
  const group = (title, hint, list) => (list.length ? `<div class="group-title"><h2>${title}</h2><span>${hint}</span></div><div class="models">${list.map(modelCard).join('')}</div>` : '');
  paint('models-body', `<div style="display:grid;gap:20px">
    <div class="models featured">${featured.map(([title, m]) => `<div class="feature"><div class="group-title"><h2>${title}</h2></div>${modelCard(m)}</div>`).join('')}</div>
    ${hubSection()}
    ${group('Compatibles', `${ok.length} modèles`, ok)}
    ${group('Hors de portée', 'mémoire ou carte insuffisante', no)}
  </div>`);
}

// ── Commande du moteur ─────────────────────────────────────
// La commande exacte du moteur chargé, à copier telle quelle ou à partager : les chemins réduits
// au nom du fichier (ils contiennent le nom d'utilisateur) et sans le fichier de clé de Harn.
let engineCmd = null;
const isPath = (arg) => /^[A-Za-z]:[\\/]|^\//.test(arg);
const baseName = (arg) => arg.split(/[\\/]/).pop();
const quote = (arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);
function commandText(cmd, share) {
  const args = [];
  for (let i = 0; i < cmd.args.length; i += 1) {
    if (share && cmd.args[i] === '--api-key-file') { i += 1; continue; }
    args.push(share && isPath(cmd.args[i]) ? baseName(cmd.args[i]) : cmd.args[i]);
  }
  const exe = share ? baseName(cmd.command) : cmd.command;
  const build = cmd.command.split(/[\\/]/).at(-2)?.match(/^b\d+.*/)?.[0];
  const lines = [`# ${cmd.label}${build ? ` · ${build}` : ''}`, [exe, ...args].map(quote).join(' ')];
  if (cmd.config) lines.push('', `# ${cmd.configName}`, cmd.config.trim());
  return lines.join('\n');
}
function renderEngineCmd() {
  if (!engineCmd) return paint('tune-cmd', '');
  if (engineCmd.error) return paint('tune-cmd', `<section class="card"><p class="empty">${esc(engineCmd.error)}</p></section>`);
  paint('tune-cmd', `<section class="card engine-cmd">
    <div class="view-head" style="margin-bottom:10px"><div><div class="label">Commande du moteur</div><p style="margin-top:6px;font-size:calc(13.5px * var(--fs))">Ce que Harn lance pour ${esc(engineCmd.label)}, avec le réglage retenu par le banc. La version à partager remplace les chemins par le nom des fichiers et retire la clé interne de Harn.</p></div>
      <div class="row"><button class="btn small" data-action="cmd-copy" data-share="1">${icon.copy} Copier pour partager</button><button class="btn small ghost" data-action="cmd-copy">Copier telle quelle</button><button class="btn small ghost" data-action="cmd-close">Fermer</button></div></div>
    <pre>${esc(commandText(engineCmd, false))}</pre></section>`);
}

// ── Réglages ───────────────────────────────────────────────
function renderTuning() {
  mount('tuning', `<div class="view"><div class="view-head" id="tune-head"></div><div id="tune-cmd"></div><div class="tuning-grid"><div style="display:grid;gap:20px"><section class="card" id="tune-arms"></section><section class="card" id="tune-iq"></section></div><aside class="card explain" id="tune-explain"></aside></div></div>`);
  const id = state.active?.modelId;
  const bench = state.profiles[id]?.bench;
  const ready = state.active?.status === 'ready';
  paint('tune-head', `<div><h1>Réglages</h1><p>${bench
    ? `Harn a essayé ${bench.arms.length} réglages de ${esc(nameOf(id))} sur votre carte, en ne changeant qu’une chose à la fois, et garde le plus rapide.`
    : 'Les réglages s’affichent après la première mesure.'}</p></div>
    ${id ? `<div class="row"><button class="btn ghost" data-action="cmd-show">${icon.terminal} Commande ${modelOf(id)?.engine === 'strata' ? 'Strata' : 'llama.cpp'}</button><button class="btn" data-action="bench" data-id="${id}" ${!ready ? 'disabled' : ''}>Remesurer</button></div>` : ''}`);
  renderEngineCmd();
  if (!bench) { paint('tune-arms', '<p class="empty">Pas encore de mesure.</p>'); }
  else {
    const all = bench.arms.flatMap((a) => (a.workloads ?? []).map((w) => w.tps));
    const max = Math.max(...all, 1);
    const hb = (cls, label, w) => (w ? `<div class="hb ${cls}"><span>${label}</span><div class="bar"><i style="width:${(w.tps / max) * 100}%"></i></div><b>${fr(w.tps)}</b></div>` : '');
    paint('tune-arms', `<div class="label">Ce qui a été mesuré · ${esc(bench.arch ?? '')} · ${clock(bench.at)}</div>
      <div class="arms">${bench.arms.map((arm) => {
        const win = arm.id === bench.winner.id;
        const w = (name) => arm.workloads?.find((x) => x.workload === name);
        if (arm.error) return `<div class="arm out"><div><div class="stage">${esc(stageOf(arm))}</div><div class="name">${esc(plainArm(arm))}<small>${esc(arm.label)}</small></div></div><div class="bars"></div><div class="score">—<small>échec</small></div><div class="reason">${esc(arm.error.slice(0, 140))}</div></div>`;
        return `<div class="arm ${win ? 'win' : ''} ${arm.ok === false ? 'out' : ''}">
          <div><div class="stage">${win ? '<span class="badge active">Retenu</span>' : esc(stageOf(arm))}</div><div class="name">${esc(plainArm(arm))}<small>${esc(arm.label)}</small></div></div>
          <div class="bars">${hb('code', 'Code', w('code'))}${hb('prose', 'Texte', w('prose'))}${hb('deep', 'Long', w('deep'))}</div>
          <div class="score">${fr(arm.tps)}<small>tok/s</small></div>
          ${arm.ok === false ? '<div class="reason">Écarté : laissait moins de 1,5 Go libres sur la carte.</div>' : ''}
        </div>`;
      }).join('')}</div>
      ${bench.winner.throttled ? '<div class="warn-line" style="margin-top:14px">La carte était en économie d’énergie pendant la mesure : les chiffres sont sous-évalués.</div>' : ''}`);
  }
  const profileIq = state.profiles[id] ?? {};
  const iq = iqResult(id);
  const LEVEL = { aucun: 'aucun palier', plancher: 'plancher', difficile: 'palier difficile', limite: 'palier limite' };
  const VERB = { concis: 'Réflexion concise', normal: 'Réflexion normale', bavard: 'Réflexion trop longue' };
  paint('tune-iq', `<div class="view-head" style="margin-bottom:6px"><div><div class="label">Banc d’intelligence</div>
      <p style="margin-top:6px;font-size:calc(13.5px * var(--fs))">Épreuves corrigées automatiquement en cinq domaines : outils, code, raisonnement, long contexte, honnêteté. Chaque domaine commence au palier difficile, monte au palier limite s’il le réussit, redescend au plancher sinon. Une seule note sur 100 pour comparer tous les modèles : 100 est rare.</p></div>
      ${id ? `<button class="btn" data-action="iq" data-id="${id}" ${profileIq.iqRunning || state.active?.status !== 'ready' ? 'disabled' : ''}>${iq ? 'Relancer' : 'Lancer le banc'}</button>` : ''}</div>
    ${profileIq.iqRunning ? `<span class="pill prefill"><span class="dot"></span>${esc(profileIq.iqRunning)}</span>` : ''}
    ${iq ? `<div class="iq-score"><span class="num">${iq.score}<small>/100</small></span><span>${iq.seconds} s · ${clock(iq.at)}</span>
        ${modelOf(id)?.rating ? `<span class="badge" title="Intelligence 40 % · taille ${modelOf(id).rating.paramsB ?? '?'}B${modelOf(id).rating.moe ? ' MoE' : ''} 25 % · vitesse mesurée 20 % · contexte 15 %">Note globale ${modelOf(id).rating.score}/100</span>` : ''}
        <span class="badge ${iq.verbosity.label === 'bavard' ? 'warn' : ''}" title="${iq.verbosity.avgTokens} tokens par réponse en moyenne${iq.verbosity.truncated ? ` · ${iq.verbosity.truncated} réponse(s) coupée(s) faute de budget` : ''}">${VERB[iq.verbosity.label]} · ${fr(iq.verbosity.avgTokens)} tokens/réponse</span></div>
      <div class="iq-cats">${CATS.map(([key, label, weight]) => { const c = iq.categories[key]; return `<div class="iq-cat"><div class="top"><span>${label} <small>${weight} %</small></span><b>${c.points}/100</b></div><div class="bar"><i style="width:${c.points}%"></i></div><div class="iq-mini">${LEVEL[c.level]}${c.tiers.plancher.played ? '' : ' · plancher acquis'}</div></div>`; }).join('')}</div>
      <div class="iq-grid">${iq.answers.map((x) => {
        const cls = x.score >= 1 ? 'ok' : x.long ? 'long' : x.score > 0 ? 'part' : 'ko';
        const mark = x.score >= 1 ? '✓' : x.long ? '…' : x.score > 0 ? '½' : '✗';
        const extra = x.total ? ` · ${x.found}/${x.total}${x.invented ? `, ${x.invented} inventée(s)` : ''}` : '';
        const tip = x.error ?? (x.long ? 'Réflexion trop longue : budget épuisé' : x.given ?? '');
        return `<div class="iq-item ${cls}" title="${esc(tip)}"><span>${mark}</span>${esc(x.theme)}${extra}<small class="tier">${esc(x.tier)}</small></div>`;
      }).join('')}</div>` : (profileIq.iqRunning ? '' : '<p class="empty">Pas encore passé. Comptez une à deux minutes.</p>')}`);
  paint('tune-explain', `<h3>Comment lire</h3>
    <p>Chaque réglage est mesuré sur trois tâches : écrire du code, écrire du texte, et répondre avec un long contexte (~20 000 tokens). Le score est la moyenne des deux premières (et de la troisième quand elle est mesurée).</p>
    <dl class="glossary">
      <dt>Anticipe N tokens</dt><dd>Le modèle devine plusieurs mots d’avance et les vérifie d’un coup. Plus profond va plus vite sur du code prévisible, moins vite sur du texte libre.</dd>
      <dt>Brouillon DFlash2</dt><dd>Un petit modèle annexe propose la suite. Souvent excellent en code.</dd>
      <dt>Mémoire de contexte</dt><dd>Précision de la mémoire de la conversation. 8 bits tient deux fois plus de contexte que 16 bits.</dd>
      <dt>Marge de 1,5 Go</dt><dd>Sous ce seuil, Windows déborde en mémoire système sans prévenir et tout ralentit fortement.</dd>
    </dl>
    <p>Mesures en mode déterministe, sortie de 384 tokens, compteurs du moteur.</p>`);
}

// ── Machine ────────────────────────────────────────────────
const dismissed = new Set((() => { try { return JSON.parse(localStorage.getItem('harn.dismissed') ?? '[]'); } catch { return []; } })());

function renderMachine() {
  mount('machine', `<div class="view">
    <div class="view-head"><div><h1>Machine</h1><p>Ce que Harn sait de votre ordinateur, ce qu’il conseille de régler, et le carnet tenu par l’IA locale.</p></div></div>
    <section class="card specs" id="specs"></section>
    <div class="machine-grid">
      <div style="display:grid;gap:20px">
        <div><div class="group-title" style="margin:0 0 12px"><h2>À vérifier</h2></div><div class="checks" id="checks"></div></div>
        <section class="card" id="notebook"></section>
      </div>
      <aside style="display:grid;gap:20px"><section class="card" id="pi-agent"></section><section class="card" id="connect"></section></aside>
    </div>
  </div>`);
  const hw = state.hardware;
  const plan = state.plan;
  if (hw) {
    paint('specs', `
      <div><div class="k">Carte graphique</div><div class="v">${esc(hw.primary?.name ?? 'Aucune')}<small>${hw.primary ? `${fr(hw.vramGiB)} Go · pilote ${esc(hw.primary.driver ?? '')}` : 'calcul sur le processeur'}</small></div></div>
      <div><div class="k">Architecture</div><div class="v">${esc(plan?.summary?.arch ?? '—')}<small>~${fr(plan?.summary?.bandwidth ?? 0)} Go/s de bande passante</small></div></div>
      <div><div class="k">Mémoire</div><div class="v">${fr(hw.ramGiB)} Go<small>RAM système</small></div></div>
      <div><div class="k">Processeur</div><div class="v">${hw.cpu.physical} cœurs<small>${esc(hw.cpu.model.replace(/\s+\d+-Core Processor/i, ''))}</small></div></div>
      <div><div class="k">Moteur</div><div class="v">${esc(plan?.backend?.label ?? '—')}<small>llama.cpp${state.runtimes ? ` ${esc(Object.values(state.runtimes)[0]?.tag ?? '')}` : ''}</small></div></div>
      <div><div class="k">Disque</div><div class="v">${hw.diskFreeGiB !== null ? `${fr(hw.diskFreeGiB)} Go` : '—'}<small>libres</small></div></div>`);
  }
  const checks = (state.checks ?? []).filter((c) => !dismissed.has(c.id));
  paint('checks', checks.length ? checks.map((c) => `<div class="card check-item ${c.level}">
      <div class="icon">${c.level === 'warn' ? icon.alert : icon.info}</div>
      <div><h3>${esc(c.title ?? c.text)}</h3>${c.title ? `<p>${esc(c.text)}</p>` : ''}${c.how ? `<div class="how">${esc(c.how)}</div>` : ''}</div>
      <div class="acts">${c.action ? `<button class="btn small primary" data-action="check" data-id="${c.id}">${esc(c.action.label)}</button>` : ''}${c.level === 'info' ? `<button class="btn small ghost" data-action="dismiss" data-id="${c.id}">C’est fait</button>` : ''}</div>
    </div>`).join('') : '<p class="empty">Rien à signaler.</p>');

  const md = state.machineDoc ?? {};
  // Le carnet sans son introduction ni ses mesures (déjà affichées dans Réglages).
  const start = doc.text.indexOf('<!-- harn:mesures:début -->');
  const body = (start >= 0 ? doc.text.slice(start) : doc.text).replace(/<!-- harn:mesures:début -->[\s\S]*?<!-- harn:mesures:fin -->/, '');
  paint('notebook', `<div class="view-head" style="margin-bottom:14px"><div><div class="label">Carnet de la machine</div>
      <p style="margin-top:6px;font-size:calc(13.5px * var(--fs))">${md.analysing ? 'L’IA locale relit ses mesures et rédige son analyse…' : md.analysedAt ? `Analyse rédigée par l’IA locale le ${new Date(md.analysedAt).toLocaleString('fr-FR')}. Les mesures détaillées sont dans Réglages.` : 'Mesures, analyse de l’IA locale et notes d’usage.'}</p></div>
      <div style="display:flex;gap:6px"><button class="btn small" data-action="analyse" ${md.analysing || state.active?.status !== 'ready' ? 'disabled' : ''}>Relancer l’analyse</button><button class="btn small ghost" data-action="open-doc">Ouvrir le fichier</button></div></div>
    ${md.error ? `<p style="color:var(--danger);font-size:calc(13px * var(--fs))">${esc(md.error)}</p>` : ''}
    <div class="doc">${body.trim() ? markdown(body.replace(/^# .*\n/, '')) : '<p class="empty">Le carnet se remplit après le premier réglage.</p>'}</div>`);

  const ketch = state.ketch;
  paint('pi-agent', `<div class="label">pi agent</div>
    <div class="pi-block">
      <h3>Instructions</h3>
      <p>Ajoutées au prompt système de pi à chaque démarrage (fichier <code>APPEND_SYSTEM.md</code>).</p>
      <div class="pi-preview doc">${piSystem.text === null ? '<p class="empty">Lecture…</p>' : markdown(piSystem.text.split('\n').slice(0, 14).join('\n'))}</div>
      <button class="btn" data-action="edit-system">Modifier les instructions</button>
      <p class="hint">Les changements comptent au prochain lancement de pi, ou après la commande <code>/reload</code>.</p>
    </div>
    <div class="pi-block">
      <h3>Recherche web</h3>
      <p>${ketch ? `ketch ${esc(ketch.version)} · outils <code>search</code>, <code>scrape</code>, <code>docs</code>, <code>code</code>, sans clé API.` : 'Installation de ketch au prochain démarrage de Harn…'}</p>
      ${ketch ? `<button class="btn" data-action="ketch-test">Tester la recherche</button>` : ''}
      ${ketchTest?.running ? '<p class="hint">Recherche en cours…</p>' : ''}
      ${ketchTest?.error ? `<p class="hint" style="color:var(--danger)">${esc(ketchTest.error)}</p>` : ''}
      ${ketchTest?.results ? `<ul class="ketch-results">${ketchTest.results.map((r) => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a><span>${esc(new URL(r.url).hostname)}</span></li>`).join('')}</ul><p class="hint">${ketchTest.results.length} résultats en ${fr(ketchTest.seconds, 1)} s.</p>` : ''}
    </div>`);
  paint('connect', accessCard());
}

// Brancher une application : adresse, clés API (reprises de Llama Control), réseau local.
function accessCard() {
  const id = state.active?.modelId ?? 'modele';
  const head = `<div class="label">Brancher une application</div>
    <div class="connect" style="margin-top:14px">
      <div class="row"><span>Adresse (compatible OpenAI)</span><code>${esc(API)}</code></div>
      <div class="row"><span>Modèle</span><code>${esc(id)}</code></div>`;
  if (!access) return `${head}<p class="empty">Lecture des clés…</p></div>`;
  const used = (k) => (k.lastUsedAt ? `${fr(k.requests)} requêtes · ${fr(k.tokens)} tokens · ${new Date(k.lastUsedAt).toLocaleString('fr-FR')}` : 'jamais utilisée');
  const stateLine = access.state === 'invalid' ? `<p class="access-warn" style="margin:0">${esc(access.error)} : toute requête est refusée.</p>`
    : access.enforced ? '<p class="access-state" style="margin:0">Clé exigée pour toute application. pi agent et Harn ont déjà la leur.</p>'
    : '<p class="access-state" style="margin:0">Aucune clé : l’API répond sans clé, à cette machine seulement. Créer une première clé ferme la porte.</p>';
  const keyUrl = newKey ? `${location.origin}/k/${newKey.token}/v1` : '';
  const secret = newKey ? `<div class="key-secret">
      <p><strong>Copiez « ${esc(newKey.key.label)} » maintenant</strong> : seule son empreinte est gardée, elle ne sera plus jamais affichée. Elle se colle dans le champ <code style="display:inline;padding:1px 5px">api_key</code> du client.</p>
      <code>${esc(newKey.token)}</code>
      <div class="acts"><button class="btn small primary" data-action="copy-text" data-text="${esc(newKey.token)}">${icon.copy} Copier la clé</button><button class="btn small" data-action="copy-text" data-text="${esc(keyUrl)}">Adresse avec la clé</button><button class="btn small ghost" data-action="key-done">C’est noté</button></div>
      <p class="hint">L’adresse avec la clé (<code style="display:inline;padding:1px 5px">/k/&lt;clé&gt;/v1</code>) sert aux clients qui ne laissent pas saisir de clé, comme Copilot. Elle peut finir dans l’historique ou les journaux du client : à réserver à cette machine ou au réseau privé.</p>
    </div>` : '';
  const keys = (access.keys ?? []).map((k) => `<div class="key-row"><div><b>${esc(k.label)}</b><small>${esc(used(k))}</small></div><button class="btn small ghost" data-action="key-revoke" data-id="${esc(k.id)}" data-label="${esc(k.label)}">Révoquer</button></div>`).join('');
  const lan = access.lan;
  const lanBody = !lan.enabled ? '<p style="margin:0">Fermé : seule cette machine joint l’API.</p>'
    : !lan.listening ? `<p class="access-warn" style="margin:0">Activé, mais le port ${lan.port} n’écoute pas (voir data/logs/harn.log).</p>`
    : `<p class="access-state" style="margin:0">Ouvert sur le port ${lan.port}, clé toujours exigée. Depuis un autre appareil :</p>
      ${lan.addresses.map((a) => `<code>${esc(a.url)}</code><p class="hint">${esc(a.name)}${a.virtual ? ' · carte virtuelle : seulement pour les machines virtuelles de ce PC' : ''}</p>`).join('') || '<p class="hint">Aucune carte réseau trouvée.</p>'}
      <p class="hint">Si l’autre appareil n’arrive pas à se connecter, autorisez le port une fois, dans PowerShell lancé en administrateur (réseaux privés seulement) :</p>
      <code>${esc(lan.firewallCommand)}</code>
      <button class="btn small ghost" data-action="copy-text" data-text="${esc(lan.firewallCommand)}">${icon.copy} Copier la commande</button>`;
  return `${head}
      ${stateLine}
      ${secret}
      ${keys ? `<div class="keys">${keys}</div>` : ''}
      <form class="add-form" data-form="key"><input id="key-label" type="text" maxlength="80" placeholder="Portable — Copilot" autocomplete="off" spellcheck="false" aria-label="Nom de la nouvelle clé"><button class="btn small" type="submit">Créer une clé</button></form>
      <p style="margin:0">Une clé par application ou par appareil : chacune se révoque seule et compte ses requêtes. Demander un autre modèle installé le charge automatiquement.</p>
      <div class="row"><span>Réseau local</span>${lanBody}</div>
      <button class="btn small" data-action="lan" data-on="${lan.enabled ? '' : '1'}" ${!lan.enabled && !access.enforced ? 'disabled title="Créez d’abord une clé"' : ''}>${lan.enabled ? 'Fermer au réseau local' : 'Ouvrir au réseau local'}</button>
      <button class="btn" data-action="copy-api">${icon.copy} Copier l’adresse</button>
    </div>`;
}

async function loadAccess() {
  const next = await fetch('/api/access').then((r) => r.json()).catch(() => null);
  if (!next) return;
  access = next;
  if (view === 'machine') renderMachine();
}

// Ce que pi demande et que seul un clic ici accorde (télécharger, relancer une installation).
let approvalsHtml = '';
function renderApprovals() {
  const pending = (state.approvals ?? []).filter((a) => a.status === 'pending');
  const html = pending.map((a) => `<section class="card approval" role="alertdialog" aria-label="${esc(a.title)}">
      <div class="label">pi agent demande</div><h3>${esc(a.title)}</h3><p>${esc(a.detail)}</p>
      <div class="acts"><button class="btn small ghost" data-approval="${esc(a.id)}" data-decision="refuse">Refuser</button><button class="btn small primary" data-approval="${esc(a.id)}" data-decision="accept">Accepter</button></div>
    </section>`).join('');
  if (html !== approvalsHtml) { approvalsHtml = html; approvalsEl.innerHTML = html; }
  document.title = pending.length ? `(${pending.length}) ${baseTitle}` : baseTitle;
}
approvalsEl.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-approval]');
  if (!button) return;
  for (const b of button.closest('.approval').querySelectorAll('button')) b.disabled = true;
  try {
    const r = await post(`/api/approvals/${button.dataset.approval}/${button.dataset.decision}`);
    toast(r.status === 'accepted' ? 'Accepté : l’installation démarre' : r.status === 'refused' ? 'Refusé : pi en est averti' : r.error ?? 'Échec');
  } catch (error) {
    toast(error.message);
    for (const b of button.closest('.approval').querySelectorAll('button')) b.disabled = false;
  }
});

async function loadSystem() {
  const next = await fetch('/api/pi/system').then((r) => r.json()).catch(() => null);
  if (!next || next.text === piSystem.text) return;
  piSystem = next;
  if (view === 'machine') renderMachine();
}
window.addEventListener('focus', () => { if (view === 'machine') { loadSystem(); loadAccess(); } });

async function loadDoc() {
  const key = state.machineDoc?.analysedAt ?? state.profiles[state.active?.modelId]?.bench?.at ?? 'x';
  if (doc.at === key) return;
  doc = { at: key, text: (await fetch('/api/machine-doc').then((r) => r.json()).catch(() => ({}))).text ?? '' };
  if (view === 'machine') { regions.delete('notebook'); renderMachine(); }
}

// ── Parcours d'installation ────────────────────────────────
function renderOnboard() {
  mount('onboard', `<section class="onboard">
    <div class="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" class="brand-bg"/><path d="M9 23V9m0 7h14m0-7v14" class="brand-mark"/></svg><span>harn</span></div>
    <div class="eyebrow">Premier démarrage</div>
    <h1 id="ob-title"></h1><p class="lede" id="ob-lede"></p>
    <dl class="machine" id="ob-machine"></dl>
    <ol class="steps" id="ob-steps"></ol>
    <div id="ob-end"></div>
    <div class="aside-note" id="ob-note"></div>
  </section>`);
  const { setup, hardware, plan } = state;
  const first = modelOf(plan?.firstModel);
  const done = setup.phase === 'done';
  const failed = setup.phase === 'error' || setup.phase === 'interrupted';
  paint('ob-title', done ? 'Votre IA locale est prête.' : failed ? 'L’installation s’est arrêtée.' : first ? `On installe ${esc(first.name)} pour vous.` : 'On regarde votre machine…');
  paint('ob-lede', esc(done
    ? 'Elle est réglée et mesurée sur votre carte. Ouvrez pi agent pour lui confier une tâche ; la vitesse s’affiche en direct dans Harn.'
    : plan?.upgradeModel ? `C’est le meilleur choix pour démarrer vite. Ensuite, on vous proposera ${modelOf(plan.upgradeModel)?.name}, encore meilleur sur votre machine.` : 'Rien à configurer : Harn choisit le moteur, le modèle et les réglages les plus rapides pour votre matériel.'));
  if (hardware) {
    const gpu = hardware.primary;
    paint('ob-machine', `
      <div><dt>Carte graphique</dt><dd>${esc(gpu?.name ?? 'Aucune')}<small>${gpu ? `${fr(hardware.vramGiB)} Go de mémoire` : 'calcul sur le processeur'}</small></dd></div>
      <div><dt>Mémoire</dt><dd>${fr(hardware.ramGiB)} Go<small>RAM système</small></dd></div>
      <div><dt>Processeur</dt><dd>${hardware.cpu.physical} cœurs<small>${esc(hardware.cpu.model.replace(/\s+\d+-Core Processor/i, ''))}</small></dd></div>
      <div><dt>Moteur choisi</dt><dd>${esc(plan?.backend?.label ?? '—')}<small>${esc(plan?.summary?.arch ?? '')}${plan?.summary?.bandwidth ? ` · ${fr(plan.summary.bandwidth)} Go/s` : ''}</small></dd></div>`);
  }
  paint('ob-steps', setup.steps.map((step) => {
    let extra = '';
    if (step.status === 'running' && step.id === 'model' && plan?.firstModel) extra = progressBlock(downloadsFor(`model:${plan.firstModel}`));
    if (step.status === 'running' && step.id === 'runtime') extra = progressBlock(downloadsFor('runtime:'));
    const elapsed = step.startedAt && step.status === 'running' ? duration((Date.now() - step.startedAt) / 1000) : step.endedAt && step.startedAt ? duration((step.endedAt - step.startedAt) / 1000) : '';
    return `<li class="step ${step.status}"><span class="step-icon">${step.status === 'done' ? icon.check : step.status === 'error' ? icon.cross : ''}</span>
      <div><div class="step-title">${esc(step.label)}</div>${step.detail ? `<div class="step-detail">${esc(step.detail)}</div>` : ''}${extra}</div>
      <span class="step-time">${elapsed}</span></li>`;
  }).join(''));
  if (done) {
    const profile = state.profiles[state.active?.modelId] ?? {};
    paint('ob-end', `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:28px">
      <button class="btn signal big" data-action="pi">${icon.terminal} Tester dans pi agent</button>
      <button class="btn big" data-action="view" data-id="home">Ouvrir Harn</button></div>
      ${profile.bench ? `<p style="color:var(--muted);margin-top:14px;font-size:calc(14px * var(--fs))">Mesuré à <b class="num" style="color:var(--text)">${fr(profile.bench.winner.tps)} tok/s</b> sur votre carte, avec ${kTokens(profile.tuning?.context ?? 0)} de contexte.</p>` : ''}`);
  } else if (failed) {
    paint('ob-end', `<div class="error-box"><p>${esc(setup.error ?? 'Harn a été fermé pendant l’installation.')}</p><button class="btn primary" data-action="retry">Reprendre</button></div>`);
  } else paint('ob-end', '');
  paint('ob-note', done && plan?.upgradeModel
    ? `<b>Et ensuite ?</b> ${esc(modelOf(plan.upgradeModel)?.name)} est encore meilleur sur votre machine. Harn vous le proposera sur l’accueil, et l’installera sans couper celui-ci.`
    : '<b>Pendant ce temps.</b> Les téléchargements reprennent là où ils s’étaient arrêtés si vous fermez Harn. Une fois le modèle chargé, Harn essaie plusieurs réglages et garde le plus rapide pour votre carte.');
}

// ── Mise à jour de Harn ────────────────────────────────────
// « Plus tard » vaut pour cette version-là : une version plus récente se signale de nouveau.
const updateEl = document.getElementById('update');
let updateSkipped = null;
try { updateSkipped = localStorage.getItem('harn.update-skipped'); } catch {}
let updating = false;
function renderUpdate() {
  const u = state.appUpdate;
  let html = '';
  if (u?.restarting || updating) html = `<div class="tip">${icon.info}<span><b>Harn redémarre avec la nouvelle version…</b> La page se recharge toute seule.</span></div>`;
  else if (u?.applying) html = `<div class="tip">${icon.info}<span><b>Mise à jour en cours…</b> ${u.mode === 'zip' ? 'Téléchargement de la nouvelle version.' : 'Récupération depuis GitHub.'}</span></div>`;
  else if (u && ['available', 'unknown'].includes(u.status) && u.remote && updateSkipped !== u.remote.sha) {
    const count = u.behindBy ? `${u.behindBy} changement${u.behindBy > 1 ? 's' : ''}` : 'nouvelle version';
    const list = u.changes?.length ? `<ul>${u.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : `<br>${esc(u.remote.message)}`;
    html = `<div class="tip">${icon.bolt}<span><b>Une nouvelle version de Harn est disponible</b> (${count}).${list}${u.error ? `<br><b>La mise à jour a échoué :</b> ${esc(u.error)}` : ''}</span>
      <div class="actions"><button class="btn small primary" data-update="apply">Mettre à jour</button><button class="btn small ghost" data-update="skip">Plus tard</button></div></div>`;
  }
  if (updateEl.innerHTML !== html) updateEl.innerHTML = html;
}
updateEl.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-update]');
  if (!button) return;
  if (button.dataset.update === 'skip') {
    updateSkipped = state.appUpdate?.remote?.sha ?? null;
    try { localStorage.setItem('harn.update-skipped', updateSkipped); } catch {}
    return renderUpdate();
  }
  button.disabled = true;
  try {
    updating = true;
    renderUpdate();
    await post('/api/update/apply');
  } catch (error) {
    updating = false;
    toast(error.message);
    renderUpdate();
  }
});

// ── Rendu ──────────────────────────────────────────────────
function render() {
  if (!state) return;
  if (state.setup.phase !== 'done' && view !== 'onboard') view = 'onboard';
  renderShell();
  renderUpdate();
  renderApprovals();
  if (view === 'onboard') renderOnboard();
  else if (view === 'models') renderModels();
  else if (view === 'tuning') renderTuning();
  else if (view === 'machine') { renderMachine(); loadDoc(); loadSystem(); if (!access) loadAccess(); }
  else renderHome();
}

function go(next) {
  view = next;
  try { sessionStorage.setItem('harn.view', next); } catch {}
  if (next === 'machine') loadAccess();
  render();
  window.scrollTo({ top: 0 });
}

app.addEventListener('submit', async (event) => {
  const keyForm = event.target.closest('[data-form="key"]');
  if (keyForm) {
    event.preventDefault();
    const button = keyForm.querySelector('button');
    button.disabled = true;
    try {
      newKey = await post('/api/access/keys', { label: keyForm.querySelector('#key-label').value });
      await loadAccess();
    } catch (error) { toast(error.message); } finally { button.disabled = false; }
    return;
  }
  const form = event.target.closest('[data-form="add-model"]');
  if (!form) return;
  event.preventDefault();
  const url = form.querySelector('#hf-url').value.trim();
  if (!/huggingface\.co\/[\w.-]+\/[\w.-]+/.test(url)) return toast('Collez une adresse de dépôt huggingface.co/auteur/modele');
  try {
    if (state.active && state.active.status !== 'ready') post(`/api/models/${state.active.modelId}/activate`);
    await post('/api/pi/launch', { model: state.active?.modelId, prompt: `Installe ce modèle avec le skill installer-un-modele : ${url}` });
    toast('pi agent s’ouvre et analyse le modèle');
  } catch (error) { toast(error.message); }
});

navEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (button) go(button.dataset.view);
});

app.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === 'view') return go(id);
  if (action === 'copy-api') return copy(API, 'Adresse de l’API copiée : collez-la dans votre application');
  if (action === 'copy-text') return copy(button.dataset.text, 'Copié');
  if (action === 'key-done') { newKey = null; return renderMachine(); }
  if (action === 'dismiss') {
    dismissed.add(id);
    try { localStorage.setItem('harn.dismissed', JSON.stringify([...dismissed])); } catch {}
    regions.delete('checks');
    return render();
  }
  button.disabled = true;
  try {
    if (action === 'pi') {
      if (state.active && state.active.status !== 'ready') post(`/api/models/${state.active.modelId}/activate`);
      const r = await post('/api/pi/launch', {}); toast(`pi agent s’ouvre avec ${nameOf(r.model)}`); }
    if (action === 'retry') await post('/api/setup/start');
    if (action === 'install') { await post(`/api/models/${id}/install`); toast('Téléchargement lancé · votre IA actuelle reste disponible'); }
    if (action === 'favorite') { const r = await post(`/api/models/${id}/favorite`); toast(r.favorite ? `${nameOf(id)} est le modèle par défaut` : 'Plus de modèle par défaut'); }
    if (action === 'delete-model') {
      const m = modelOf(id);
      const warn = state.active?.modelId === id ? '\n\nC’est le modèle chargé : il sera déchargé.' : '';
      if (!confirm(`Supprimer ${m.name} · ${m.variant} ?\n\nSes fichiers (${gb(m.totalBytes)}), ses réglages et ses notes seront effacés.${m.custom ? ' Il disparaîtra aussi de la liste ; vous pourrez le rajouter depuis Hugging Face.' : ' Il restera dans le catalogue pour être réinstallé.'}${warn}`)) return;
      const r = await post(`/api/models/${id}/delete`);
      catalog = await fetch('/api/catalog').then((res) => res.json());
      regions.clear(); app.dataset.view = ''; render();
      toast(`${m.name} supprimé${r.freedBytes ? ` · ${gb(r.freedBytes)} libérés` : ''}`);
    }
    if (action === 'activate') { await post(`/api/models/${id}/activate`); toast('Chargement…'); }
    if (action === 'unload') { await post('/api/engine/stop'); toast('Carte graphique libérée'); }
    if (action === 'open-log') { await post(`/api/models/${id}/log`); toast('Journal ouvert'); }
    if (action === 'retry') { await post(`/api/models/${id}/retry`); toast('Nouvelle tentative'); }
    if (action === 'ask-pi') { const r = await post(`/api/models/${id}/ask-pi`); toast(`pi s’ouvre avec ${nameOf(r.helper)} pour dépanner`); }
    if (action === 'iq') { await post(`/api/models/${id}/iq`); toast('Test d’intelligence lancé'); }
    if (action === 'bench') { await post(`/api/models/${id}/bench`); toast('Nouvelle mesure en cours'); }
    if (action === 'cmd-show') {
      engineCmd = await fetch('/api/engine/command').then(async (r) => (r.ok ? r.json() : { error: (await r.json()).error }));
      renderEngineCmd();
    }
    if (action === 'cmd-close') { engineCmd = null; renderEngineCmd(); }
    if (action === 'cmd-copy' && engineCmd && !engineCmd.error) await copy(commandText(engineCmd, Boolean(button.dataset.share)), button.dataset.share ? 'Commande copiée, prête à partager' : 'Commande copiée');
    if (action === 'hub-check') { await post('/api/watch/check'); toast('Recherche des nouveautés sur Hugging Face'); }
    if (action === 'hub-dismiss') { await post('/api/watch/dismiss', { repo: button.dataset.repo }); toast('Ce modèle ne sera plus proposé'); }
    if (action === 'hub-install') {
      const { repo, quant, mmproj } = button.dataset;
      if (!confirm(`Installer ${repo} · ${quant} ?

Harn le télécharge, le règle pour votre carte et teste son intelligence. Votre IA actuelle reste disponible pendant ce temps.`)) return;
      await post('/api/custom/install', { url: `https://huggingface.co/${repo}`, quant, mmproj: mmproj || null });
      toast('Installation lancée : suivez-la dans la liste des modèles');
    }
    if (action === 'check') { const r = await post(`/api/checks/${id}/apply`); toast(r.message); }
    if (action === 'key-revoke') {
      if (!confirm(`Révoquer la clé « ${button.dataset.label} » ?\n\nLes applications qui l’utilisent seront refusées. Elle ne pourra pas être réactivée.`)) return;
      const r = await post(`/api/access/keys/${id}/revoke`);
      access = r.access;
      renderMachine();
      toast(`Clé « ${r.revoked.label} » révoquée`);
    }
    if (action === 'lan') {
      access = await post('/api/access/lan', { enabled: Boolean(button.dataset.on) });
      renderMachine();
      toast(access.lan.enabled ? `API ouverte au réseau local (port ${access.lan.port})` : 'API fermée au réseau local');
    }
    if (action === 'edit-system') { const r = await post('/api/pi/system/open'); toast(`Instructions ouvertes dans le ${r.editor}`); }
    if (action === 'ketch-test') {
      ketchTest = { running: true };
      renderMachine();
      try { ketchTest = await post('/api/ketch/test'); } catch (error) { ketchTest = { error: error.message }; }
      renderMachine();
    }
    if (action === 'open-doc') { await post('/api/machine-doc/open'); toast('Carnet ouvert'); }
    if (action === 'analyse') { await post('/api/machine-doc/analyse'); toast('L’IA locale relit ses mesures'); }
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

async function boot() {
  const initial = await fetch('/api/state').then((r) => r.json());
  catalog = initial.catalog;
  state = initial.state;
  benchMarks = benchMarksOf();
  live = initial.live;
  try { view = sessionStorage.getItem('harn.view') ?? 'home'; } catch { view = 'home'; }
  if (state.setup.phase !== 'done') view = 'onboard';
  render();

  const source = new EventSource('/api/events');
  source.addEventListener('state', (event) => {
    state = JSON.parse(event.data);
    // La note globale est calculée par le serveur : on recharge le catalogue quand un banc change.
    const marks = benchMarksOf();
    const stale = marks !== benchMarks;
    benchMarks = marks;
    if (stale || Object.keys(state.models).some((id) => !catalog.some((m) => m.id === id))) fetch('/api/catalog').then((r) => r.json()).then((list) => { catalog = list; regions.clear(); app.dataset.view = ''; render(); });
    render();
    if (view === 'machine') loadDoc();
  });
  source.addEventListener('live', (event) => {
    live = JSON.parse(event.data);
    if (view === 'home') { renderGauge(); renderActivity(); }
  });
  // Après une mise à jour, le serveur relancé sert le nouveau code : on recharge la page.
  source.onopen = () => { if (updating) location.reload(); };
  source.onerror = () => { statusEl.innerHTML = '<span class="dot error"></span><span><b>Connexion perdue</b>Harn est-il fermé ?</span>'; };
}
setInterval(() => { if (state?.setup.phase === 'running') render(); }, 1000);
boot();
