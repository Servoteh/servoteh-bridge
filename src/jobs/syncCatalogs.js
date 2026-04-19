import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';
import { syncCustomers } from './syncCustomers.js';
import { syncDepartments } from './syncDepartments.js';
import { syncMachines } from './syncMachines.js';
import { syncWorkers } from './syncWorkers.js';

const log = logJob('syncCatalogs');

/**
 * Zbirni dnevni job: sva 4 kataloga.
 * Redosled je važan zbog FK-ova u Supabase-u:
 *   1) departments (parent)
 *   2) machines    (FK -> departments.id)
 *   3) customers   (nezavisno)
 *   4) workers     (FK -> departments.id)
 *
 * Svaki underlying job ima svoj sync_log zapis. Ovaj wrapper takođe loguje
 * jedan composite zapis ('catalogs_daily') sa zbirnim rows_updated.
 */
export async function syncCatalogs() {
  const run = await startRun('catalogs_daily');
  log.info('start');
  let total = 0;
  try {
    const d = await syncDepartments();
    total += d.total;
    const m = await syncMachines();
    total += m.total;
    const c = await syncCustomers();
    total += c.total;
    const w = await syncWorkers();
    total += w.total;

    await finishRun(run, { rowsUpdated: total });
    log.info({ totalRows: total }, 'all 4 catalogs done');
    return { total };
  } catch (err) {
    log.error({ err }, 'catalogs job failed');
    await failRun(run, err);
    throw err;
  }
}
