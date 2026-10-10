import { detectHardware } from './hardware.mjs';
import { makePlan } from './planner.mjs';
import { iqScores } from './scores.mjs';
import { getState, update } from './state.mjs';
import { systemChecks } from './system-checks.mjs';

// Relevé de la machine et plan qui en découle.
export async function refreshHardware() {
  const hardware = await detectHardware();
  const ours = getState().active?.status === 'ready' || getState().active?.status === 'loading';
  hardware.vramBaselineMiB = ours ? getState().vramBaselineMiB ?? null : (hardware.primary?.freeMiB != null ? hardware.primary.vramMiB - hardware.primary.freeMiB : null);
  const plan = makePlan(hardware, iqScores(), getState().profiles);
  // La VRAM prise par les autres applications se lit avant qu'on charge quoi que ce soit.
  const checks = await systemChecks(hardware, { vramBaselineMiB: ours ? getState().vramBaselineMiB ?? 0 : null });
  update((s) => {
    s.hardware = hardware;
    s.plan = plan;
    s.checks = checks;
    if (!ours && hardware.primary?.freeMiB != null) s.vramBaselineMiB = hardware.primary.vramMiB - hardware.primary.freeMiB;
  });
  return { hardware, plan };
}
