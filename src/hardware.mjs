import { execFile } from 'node:child_process';
import { access, readdir, readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HOME } from './paths.mjs';

const run = promisify(execFile);
const GiB = 1024 ** 3;

async function tryRun(command, args, options = {}) {
  try {
    const { stdout } = await run(command, args, { windowsHide: true, timeout: 15_000, ...options });
    return stdout;
  } catch {
    return null;
  }
}

// NVIDIA d'abord : c'est la seule famille pour laquelle on connaît la VRAM libre, la version
// CUDA prise en charge par le pilote et la génération (compute capability).
async function nvidiaGpus() {
  const csv = await tryRun('nvidia-smi', [
    '--query-gpu=index,name,memory.total,memory.free,driver_version,compute_cap,pstate',
    '--format=csv,noheader,nounits',
  ]);
  if (!csv) return [];
  const header = (await tryRun('nvidia-smi', [])) ?? '';
  // Les pilotes récents écrivent « CUDA UMD Version », les anciens « CUDA Version ».
  const cuda = header.match(/CUDA (?:UMD )?Version:\s*([\d.]+)/)?.[1] ?? null;
  return csv.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [index, name, total, free, driver, cc, pstate] = line.split(',').map((cell) => cell.trim());
    return {
      vendor: 'nvidia',
      index: Number(index),
      name,
      vramMiB: Number(total),
      freeMiB: Number(free),
      driver,
      cuda,
      computeCapability: Number(cc),
      pstate,
    };
  });
}

// Les autres cartes sous Windows : Win32_VideoController plafonne AdapterRAM à 4 Gio, la vraie
// taille est dans le registre du pilote (qwMemorySize).
async function windowsOtherGpus() {
  if (process.platform !== 'win32') return [];
  const script = `
$items = Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue
$items | Where-Object { $_.DriverDesc } | ForEach-Object {
  [pscustomobject]@{ name = $_.DriverDesc; bytes = $_.'HardwareInformation.qwMemorySize' }
} | ConvertTo-Json -Compress`;
  const out = await tryRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!out?.trim()) return [];
  const list = [].concat(JSON.parse(out));
  return list
    .filter((gpu) => !/nvidia|microsoft basic|remote display|virtual/i.test(gpu.name))
    .map((gpu, index) => ({
      vendor: /amd|radeon/i.test(gpu.name) ? 'amd' : /intel|arc/i.test(gpu.name) ? 'intel' : 'other',
      index,
      name: gpu.name,
      vramMiB: gpu.bytes ? Math.round(Number(gpu.bytes) / 1024 ** 2) : 0,
      freeMiB: null,
    }));
}

// Les Radeon sous Linux : tout est dans sysfs, sans ROCm ni droit particulier. La VRAM se lit
// même quand la carte dort (runtime PM) ; les capteurs, eux, répondent EBUSY et ne la réveillent pas.
const DRM = '/sys/class/drm';
const readSys = (file) => readFile(file, 'utf8').then((text) => text.trim()).catch(() => null);
const sysNumber = async (file) => { const text = await readSys(file); return text === null || text === '' ? null : Number(text); };

async function linuxAmdGpus() {
  if (process.platform !== 'linux') return [];
  const cards = (await readdir(DRM).catch(() => [])).filter((name) => /^card\d+$/.test(name)).sort();
  const gpus = [];
  for (const card of cards) {
    const device = path.join(DRM, card, 'device');
    if ((await readSys(path.join(device, 'vendor'))) !== '0x1002') continue;
    const total = await sysNumber(path.join(device, 'mem_info_vram_total'));
    if (!total) continue;
    const used = await sysNumber(path.join(device, 'mem_info_vram_used'));
    const slot = (await readSys(path.join(device, 'uevent')))?.match(/PCI_SLOT_NAME=(\S+)/)?.[1] ?? null;
    const pciId = (await readSys(path.join(device, 'device')))?.replace(/^0x/, '') ?? '?';
    // « Navi 48 [Radeon AI PRO R9700] » : le nom commercial est entre crochets.
    const lspci = slot ? await tryRun('lspci', ['-mm', '-s', slot]) : null;
    const chip = lspci?.match(/^\S+ "[^"]*" "[^"]*" "([^"]*)"/)?.[1] ?? null;
    const name = chip ? `AMD ${chip.match(/\[([^\]]+)\]/)?.[1] ?? chip}` : `AMD Radeon (1002:${pciId})`;
    gpus.push({
      vendor: 'amd',
      index: gpus.length,
      name,
      vramMiB: Math.round(total / 1024 ** 2),
      freeMiB: used === null ? null : Math.round((total - used) / 1024 ** 2),
      driver: 'amdgpu',
      // La puce intégrée n'a qu'une réserve de quelques centaines de Mo prise sur la RAM.
      integrated: total < 2 * GiB,
      sysfs: device,
    });
  }
  return gpus;
}

// ROCm (pour HIP sous Linux) : il faut sudo pour l'installer, Harn ne peut que le constater.
// Deux origines : le dépôt d'AMD (/opt/rocm) ou les paquets de la distribution (Ubuntu 26.04
// livre ROCm 7.1 dans /usr). C'est la bibliothèque HIP qui compte : sans elle, rien ne tourne.
const HIP_LIBS = ['/opt/rocm/lib/libamdhip64.so', '/usr/lib/x86_64-linux-gnu/libamdhip64.so', '/usr/lib64/libamdhip64.so', '/usr/lib/libamdhip64.so'];
export async function linuxRocm() {
  if (process.platform !== 'linux') return null;
  let lib = null;
  for (const file of HIP_LIBS) if (await access(file).then(() => true, () => false)) { lib = file; break; }
  if (!lib) return null;
  const version = (await readSys('/opt/rocm/.info/version')) ?? (await tryRun('hipconfig', ['--version']))?.trim() ?? null;
  return { version: version?.split('-')[0] ?? null, lib };
}

// La commande qui installe ROCm, selon la distribution (sudo : c'est l'utilisateur qui la tape).
export async function rocmInstallHint() {
  const release = (await readSys('/etc/os-release')) ?? '';
  const id = release.match(/^ID=(.*)$/m)?.[1]?.replace(/"/g, '');
  const version = Number.parseFloat(release.match(/^VERSION_ID="?([\d.]+)/m)?.[1] ?? '0');
  if (id === 'ubuntu' && version >= 25.10) return 'sudo apt install rocm';
  if (id === 'ubuntu' || id === 'debian') return 'Ajouter le dépôt ROCm d’AMD (rocm.docs.amd.com, « Quick start installation »), puis : sudo apt install rocm';
  if (id === 'fedora') return 'sudo dnf install rocm';
  if (id === 'arch') return 'sudo pacman -S rocm-hip-sdk';
  return 'Suivre rocm.docs.amd.com, « Quick start installation »';
}

async function cpuInfo() {
  const cpus = os.cpus();
  let physical = null;
  if (process.platform === 'win32') {
    const out = await tryRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum']);
    physical = Number(out?.trim()) || null;
  }
  const model = cpus[0]?.model?.trim() ?? 'Processeur inconnu';
  // AVX-512 / Zen 4 : les builds CPU de llama.cpp choisissent leur variante seuls (ggml-cpu-*.dll).
  return { model, logical: os.availableParallelism(), physical: physical ?? Math.max(1, Math.round(cpus.length / 2)) };
}

async function gitBash() {
  if (process.platform !== 'win32') return true;
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    if (await tryRun(`${base}\\Git\\bin\\bash.exe`, ['-c', 'echo ok'])) return true;
  }
  return Boolean(await tryRun('bash.exe', ['-c', 'echo ok']));
}

// Linux : Strata (setup.sh) a besoin d'un Python 3.10+ capable de créer un venv avec pip.
// Debian/Ubuntu livrent venv sans ensurepip (paquet python3-venv à part), et l'installer demande
// sudo : Harn ne peut que le signaler. Même test que setup.sh. null hors Linux.
export async function linuxPython() {
  if (process.platform !== 'linux') return null;
  const probe = 'import sys, venv, ensurepip; sys.exit(0 if sys.version_info >= (3, 10) else 1)';
  for (const command of ['python3', 'python']) if ((await tryRun(command, ['-c', probe])) !== null) return { ok: true, command };
  return { ok: false };
}

// Linux : de quoi compiler un moteur CUDA (llamAmpere). nvcc n'accepte qu'une plage de g++ :
// 12.4-12.6 jusqu'à g++ 13, 12.8-12.9 jusqu'à 14, 13.x jusqu'à 15. Ubuntu récent livre un g++ plus
// neuf que ce que son nvcc accepte : on cherche alors un g++-N installé à côté.
export async function buildTools() {
  if (process.platform !== 'linux') return null;
  const nvcc = (await tryRun('nvcc', ['--version']))?.match(/release (\d+)\.(\d+)/);
  const cmake = Boolean(await tryRun('cmake', ['--version']));
  if (!nvcc) return { ok: false, nvcc: null, cmake, hostCompiler: null };
  const [major, minor] = [Number(nvcc[1]), Number(nvcc[2])];
  const maxGcc = major >= 13 ? 15 : minor >= 8 ? 14 : 13;
  let hostCompiler = null;
  for (const name of ['g++', ...Array.from({ length: maxGcc - 10 }, (_, i) => `g++-${maxGcc - i}`)]) {
    const version = Number.parseInt(await tryRun(name, ['-dumpversion']) ?? '', 10);
    if (version && version <= maxGcc) { hostCompiler = name; break; }
  }
  return { ok: Boolean(cmake && hostCompiler), nvcc: `${major}.${minor}`, cmake, hostCompiler };
}

// Podman : les moteurs livrés en image de conteneur (vllm-radiance pour les Radeon RDNA4) passent
// par lui, sans démon ni droits root. Seulement constaté : son installation demande sudo.
export async function linuxPodman() {
  if (process.platform !== 'linux') return null;
  return (await tryRun('podman', ['--version']))?.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
}

export async function detectHardware() {
  const [nvidia, others, amd, cpu, disk, hasGitBash, python, tools, rocm, podman] = await Promise.all([
    nvidiaGpus(),
    windowsOtherGpus(),
    linuxAmdGpus(),
    cpuInfo(),
    statfs(HOME).catch(() => null),
    gitBash(),
    linuxPython(),
    buildTools(),
    linuxRocm(),
    linuxPodman(),
  ]);
  const gpus = [...nvidia, ...others, ...amd];
  // La carte de référence : la plus grosse NVIDIA, sinon la plus grosse dédiée. Une puce intégrée
  // seule n'en fait pas une : ses quelques centaines de Mo ne portent aucun modèle.
  const primary = [...gpus].filter((gpu) => !gpu.integrated)
    .sort((a, b) => (b.vendor === 'nvidia') - (a.vendor === 'nvidia') || b.vramMiB - a.vramMiB)[0] ?? null;
  amdSysfs = primary?.vendor === 'amd' ? primary.sysfs ?? null : null;
  return {
    detectedAt: new Date().toISOString(),
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    cpu,
    ramGiB: +(os.totalmem() / GiB).toFixed(1),
    freeRamGiB: +(os.freemem() / GiB).toFixed(1),
    gpus,
    primary,
    vramGiB: primary ? +(primary.vramMiB / 1024).toFixed(1) : 0,
    diskFreeGiB: disk ? +((disk.bavail * disk.bsize) / GiB).toFixed(0) : null,
    node: process.versions.node,
    gitBash: hasGitBash,
    python,
    buildTools: tools,
    rocm,
    podman,
  };
}

// Relevé léger pour le direct : un nvidia-smi par seconde au plus, quand l'interface regarde.
// Radeon sous Linux : lu dans sysfs, sur la carte retenue au dernier relevé matériel.
let gpuSampler = null;
let amdSysfs = null;
export const setGpuSampler = (sampler) => { gpuSampler = sampler; };

async function sampleAmd(device) {
  const total = await sysNumber(path.join(device, 'mem_info_vram_total'));
  if (!total) return null;
  const used = await sysNumber(path.join(device, 'mem_info_vram_used'));
  // Carte en veille : les capteurs refusent de répondre, et c'est très bien ainsi.
  const asleep = (await readSys(path.join(device, 'power', 'runtime_status'))) === 'suspended';
  const hwmon = (await readdir(path.join(device, 'hwmon')).catch(() => []))[0];
  const sensor = async (name) => (asleep || !hwmon ? null : sysNumber(path.join(device, 'hwmon', hwmon, name)));
  const [util, power, junction, edge, sclk] = await Promise.all([
    asleep ? 0 : sysNumber(path.join(device, 'gpu_busy_percent')),
    sensor('power1_average').then((v) => v ?? sensor('power1_input')),
    sensor('temp2_input'), sensor('temp1_input'), sensor('freq1_input'),
  ]);
  const MiB = 1024 ** 2;
  return {
    util: util ?? 0, usedMiB: Math.round((used ?? 0) / MiB), freeMiB: Math.round((total - (used ?? 0)) / MiB), totalMiB: Math.round(total / MiB),
    powerW: power ? Math.round(power / 1e6) : null, tempC: (junction ?? edge) ? Math.round((junction ?? edge) / 1000) : null,
    pstate: asleep ? 'veille' : 'active', smMHz: sclk ? Math.round(sclk / 1e6) : null,
  };
}

export async function sampleGpu() {
  if (gpuSampler) return gpuSampler();
  if (amdSysfs) return sampleAmd(amdSysfs);
  const csv = await tryRun('nvidia-smi', [
    '--query-gpu=utilization.gpu,memory.used,memory.free,memory.total,power.draw,temperature.gpu,pstate,clocks.sm',
    '--format=csv,noheader,nounits', '-i', '0',
  ], { timeout: 3_000 });
  if (!csv) return null;
  const [util, used, free, total, power, temp, pstate, sm] = csv.trim().split(',').map((cell) => cell.trim());
  return {
    util: Number(util), usedMiB: Number(used), freeMiB: Number(free), totalMiB: Number(total),
    powerW: Number(power) || null, tempC: Number(temp), pstate, smMHz: Number(sm),
  };
}
