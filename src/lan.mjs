import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { PORTS } from './paths.mjs';

// L'API OpenAI ouverte au réseau local (repris de Llama Control). Un port à part, qui ne sert que
// /v1 : l'interface et l'API de contrôle de Harn restent sur la boucle locale, quoi qu'il arrive.
// Une clé créée y est toujours exigée (voir gateway.mjs).

let server = null;

const privateIpv4 = (address) => /^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address);

// Les adresses par lesquelles un autre appareil joindra cette machine : privées d'abord, cartes
// virtuelles (WSL, Hyper-V, Docker) en dernier.
export function lanAddresses(interfaces = networkInterfaces()) {
  const found = [];
  for (const [name, entries] of Object.entries(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      if (!['IPv4', 4].includes(entry.family) || entry.internal || !entry.address || /^169\.254\./.test(entry.address)) continue;
      found.push({ name, address: entry.address, private: privateIpv4(entry.address), virtual: /vethernet|wsl|docker|hyper-v|vmware|vmnet|virtualbox|loopback/i.test(name) });
    }
  }
  return [...new Map(found.map((e) => [e.address, e])).values()]
    .sort((a, b) => Number(b.private) - Number(a.private) || Number(a.virtual) - Number(b.virtual) || a.name.localeCompare(b.name))
    .map(({ name, address, private: isPrivate, virtual }) => ({ name, address, private: isPrivate, virtual, url: `http://${address}:${PORTS.lan}/v1` }));
}

export function lanDetails() {
  return {
    listening: Boolean(server?.listening),
    port: PORTS.lan,
    addresses: lanAddresses(),
    // Windows demande l'autorisation au premier lancement ; sinon cette règle, une seule fois,
    // en PowerShell administrateur. Profil Private : jamais sur un Wi-Fi public.
    firewallCommand: `New-NetFirewallRule -DisplayName "Harn - API ${PORTS.lan}" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORTS.lan} -Profile Private`,
  };
}

export function startLan(handler) {
  if (server?.listening) return Promise.resolve(lanDetails());
  return new Promise((resolve, reject) => {
    const candidate = http.createServer(handler);
    candidate.once('error', (error) => {
      server = null;
      reject(new Error(error.code === 'EADDRINUSE' ? `Le port ${PORTS.lan} est déjà utilisé par un autre programme` : error.message));
    });
    candidate.listen(PORTS.lan, '0.0.0.0', () => { server = candidate; resolve(lanDetails()); });
  });
}

export function stopLan() {
  if (!server) return Promise.resolve();
  const closing = server;
  server = null;
  // Les connexions gardées ouvertes (keep-alive, flux en cours) sont coupées : l'accès est retiré.
  return new Promise((resolve) => { closing.close(() => resolve()); closing.closeAllConnections?.(); });
}
