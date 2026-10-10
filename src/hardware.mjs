import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import { ROOT } from './paths.mjs';

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

export async function detectHardware() {
  const [nvidia, others, cpu, disk, hasGitBash, python, tools] = await Promise.all([
    nvidiaGpus(),
    windowsOtherGpus(),
    cpuInfo(),
    statfs(ROOT).catch(() => null),
    gitBash(),
    linuxPython(),
    buildTools(),
  ]);
  const gpus = [...nvidia, ...others];
  // La carte de référence : la plus grosse NVIDIA, sinon la plus grosse tout court.
  const primary = [...gpus].sort((a, b) => (b.vendor === 'nvidia') - (a.vendor === 'nvidia') || b.vramMiB - a.vramMiB)[0] ?? null;
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
  };
}

// Relevé léger pour le direct : un nvidia-smi par seconde au plus, quand l'interface regarde.
export async function sampleGpu() {
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
