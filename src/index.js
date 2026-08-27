/** Programmatic surface, for wiring the tracker into other tooling. */
export { run, main } from './cli.js';
export { loadState, savePeriod, archivePeriod, resolvePeriod, archiveIds, loadArchived } from './core/state.js';
export { computeMetrics, compareMetrics } from './core/metrics.js';
export { loadConfig, saveConfig, defaultConfig } from './core/config.js';
export { loadModelTable, resolveModel, planAllowance } from './core/models.js';
export {
  recordPrompt,
  startSession,
  closeSession,
  activeSession,
  allPrompts,
  loggedSessions,
  importedSessions,
  isImported,
  ORIGIN_IMPORT,
} from './core/ledger.js';
export { bucketRecords, planImport, applyImport, inferModel, normalizeRecord } from './core/import.js';
export { parseCsvRecords } from './util/csv.js';
export { cycleStartFor, cycleEndFor, periodIdFor, periodProgress, makePeriod } from './core/period.js';
export { dataHome, paths } from './core/paths.js';
