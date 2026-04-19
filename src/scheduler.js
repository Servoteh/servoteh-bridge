import cron from 'node-cron';

import { config } from './config.js';
import { syncCatalogs } from './jobs/syncCatalogs.js';
import { logger } from './logger.js';

let _registered = false;
let _runningCatalogs = false;

/**
 * Wraper koji sprečava preklapanje istog joba: ako je prethodni run još u toku
 * (npr. kasni > 24h iz nekog razloga), preskoči novi tick i samo loguj.
 */
async function safeCatalogs() {
  if (_runningCatalogs) {
    logger.warn('[scheduler] catalogs run still in progress, skipping this tick');
    return;
  }
  _runningCatalogs = true;
  try {
    await syncCatalogs();
  } catch (err) {
    logger.error({ err }, '[scheduler] catalogs run threw (will retry next tick)');
  } finally {
    _runningCatalogs = false;
  }
}

export function startScheduler() {
  if (_registered) {
    logger.warn('[scheduler] already started');
    return;
  }
  if (!config.scheduler.enabled) {
    logger.info('[scheduler] disabled via SCHEDULER_ENABLED=false (running in idle)');
    _registered = true;
    return;
  }

  if (!cron.validate(config.scheduler.catalogsCron)) {
    throw new Error(`[scheduler] Invalid cron expression: ${config.scheduler.catalogsCron}`);
  }

  cron.schedule(config.scheduler.catalogsCron, safeCatalogs, {
    timezone: config.scheduler.timezone,
  });
  logger.info(
    { cron: config.scheduler.catalogsCron, tz: config.scheduler.timezone },
    '[scheduler] catalogs job registered',
  );

  _registered = true;
}
