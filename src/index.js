/** Programmatic surface, for wiring the tracker into other tooling. */
export { run, main } from './cli.js';
export { loadState, savePeriod, archivePeriod, resolvePeriod, archiveIds, loadArchived } from './core/state.js';
export { computeMetrics, compareMetrics } from './core/metrics.js';
export { loadConfig, saveConfig, defaultConfig } from './core/config.js';
export { loadModelTable, resolveModel, planAllowance } from './core/models.js';
export { recordPrompt, startSession, closeSession, activeSession, allPrompts } from './core/ledger.js';
export { cycleStartFor, cycleEndFor, periodIdFor, periodProgress, makePeriod } from './core/period.js';
export { dataHome, paths } from './core/paths.js';
