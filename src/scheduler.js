import cron from 'node-cron';

import { config } from './config.js';
import { syncCatalogs } from './jobs/syncCatalogs.js';
import { syncProduction } from './jobs/syncProduction.js';
import { logger } from './logger.js';

let _registered = false;
let _runningCatalogs = false;
let _runningProduction = false;

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

/**
 * Production wraper — radi se na svakih 15 minuta. Ako prethodni run još
 * traje (mreža/SQL spori), preskoči ovaj tick.
 */
async function safeProduction() {
  if (_runningProduction) {
    logger.warn('[scheduler] production run still in progress, skipping this tick');
    return;
  }
  _runningProduction = true;
  try {
    await syncProduction();
  } catch (err) {
    logger.error({ err }, '[scheduler] production run threw (will retry next tick)');
  } finally {
    _runningProduction = false;
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
    throw new Error(`[scheduler] Invalid catalogs cron expression: ${config.scheduler.catalogsCron}`);
  }
  if (!cron.validate(config.scheduler.productionCron)) {
    throw new Error(`[scheduler] Invalid production cron expression: ${config.scheduler.productionCron}`);
  }

  cron.schedule(config.scheduler.catalogsCron, safeCatalogs, {
    timezone: config.scheduler.timezone,
  });
  logger.info(
    { cron: config.scheduler.catalogsCron, tz: config.scheduler.timezone },
    '[scheduler] catalogs job registered',
  );

  cron.schedule(config.scheduler.productionCron, safeProduction, {
    timezone: config.scheduler.timezone,
  });
  logger.info(
    { cron: config.scheduler.productionCron, tz: config.scheduler.timezone },
    '[scheduler] production job registered',
  );

  _registered = true;
}
