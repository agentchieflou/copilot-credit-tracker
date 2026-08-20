import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR_NAME = 'copilot-credit-tracker';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Package root, used to locate the bundled default model table. */
export const packageRoot = path.resolve(here, '..', '..');

/**
 * Where persistent state lives. This is deliberately outside the repo and
 * outside the cwd so the tool works identically from any directory and
 * survives across shell sessions, terminals and machines-with-roaming-profiles.
 * Override with CCRED_HOME (useful for tests, or for keeping a work profile
 * separate from a personal one).
 */
export function dataHome() {
  if (process.env.CCRED_HOME) return path.resolve(process.env.CCRED_HOME);
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, APP_DIR_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, APP_DIR_NAME);
}

export function paths() {
  const home = dataHome();
  return {
    home,
    configFile: path.join(home, 'config.json'),
    currentFile: path.join(home, 'current.json'),
    modelsOverrideFile: path.join(home, 'models.override.json'),
    archiveDir: path.join(home, 'archive'),
    archiveFile: (periodId) => path.join(home, 'archive', `${periodId}.json`),
    bundledModelsFile: path.join(packageRoot, 'data', 'models.json'),
  };
}
