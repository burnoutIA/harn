import path from 'node:path';
import { askLocalAnalysis, machineDocPath } from './machine-doc.mjs';
import { update } from './state.mjs';

// L'analyse des mesures par l'IA locale, écrite dans le carnet de la machine.
let analysing = null;
export function runAnalysis() {
  analysing ??= (async () => {
    update((s) => { s.machineDoc = { ...(s.machineDoc ?? {}), path: machineDocPath(s.hardware), analysing: true, error: null }; });
    try {
      await askLocalAnalysis();
      update((s) => { s.machineDoc = { ...s.machineDoc, analysing: false, analysedAt: new Date().toISOString() }; });
    } catch (error) {
      update((s) => { s.machineDoc = { ...s.machineDoc, analysing: false, error: error.message }; });
    }
  })().finally(() => { analysing = null; });
  return analysing;
}
