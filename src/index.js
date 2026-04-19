import { describeConfig } from './config.js';
import { closeSqlPool } from './db/sqlserver.js';
import { syncCatalogs } from './jobs/syncCatalogs.js';
import { syncCustomers } from './jobs/syncCustomers.js';
import { syncDepartments } from './jobs/syncDepartments.js';
import { syncLocations } from './jobs/syncLocations.js';
import { syncMachines } from './jobs/syncMachines.js';
import { syncWorkers } from './jobs/syncWorkers.js';
import { logger } from './logger.js';
import { startScheduler } from './scheduler.js';

function parseArgs(argv) {
  const args = { once: false, job: null };
  for (const a of argv.slice(2)) {
    if (a === '--once') args.once = true;
    else if (a.startsWith('--job=')) args.job = a.slice('--job='.length);
  }
  return args;
}

async function runOne(jobName) {
  switch (jobName) {
    case 'departments':
      await syncDepartments();
      return;
    case 'machines':
      await syncMachines();
      return;
    case 'customers':
      await syncCustomers();
      return;
    case 'workers':
      await syncWorkers();
      return;
    case 'locations':
      await syncLocations();
      return;
    case 'catalogs':
    case null:
    case undefined:
    case '':
      await syncCatalogs();
      return;
    default:
      throw new Error(`Unknown --job=${jobName}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  logger.info(
    { args, config: describeConfig(), node: process.version, platform: process.platform },
    'bridge starting',
  );

  if (args.once) {
    try {
      await runOne(args.job);
      logger.info('one-shot run complete, exiting');
      await closeSqlPool();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'one-shot run failed');
      await closeSqlPool();
      process.exit(1);
    }
  }

  startScheduler();
  logger.info('bridge running (scheduled mode). Ctrl+C to stop.');

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down…');
    await closeSqlPool();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down…');
    await closeSqlPool();
    process.exit(0);
  });
}

main().catch(async (err) => {
  logger.fatal({ err }, 'bridge crashed in main');
  await closeSqlPool().catch(() => {});
  process.exit(1);
});
