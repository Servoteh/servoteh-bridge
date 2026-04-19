import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';
import { syncCustomers } from './syncCustomers.js';
import { syncDepartments } from './syncDepartments.js';
import { syncLocations } from './syncLocations.js';
import { syncMachines } from './syncMachines.js';
import { syncWorkers } from './syncWorkers.js';

const log = logJob('syncCatalogs');

/**
 * Zbirni dnevni job: 5 kataloga.
 * Redosled je važan zbog FK-ova u Supabase-u:
 *   1) departments (parent)
 *   2) machines    (FK -> departments.id)
 *   3) customers   (nezavisno)
 *   4) workers     (FK -> departments.id)
 *   5) locations   (FK -> departments.id)  — pretpostavljena shema
 *
 * Svaki underlying job ima svoj sync_log zapis. Ovaj wrapper takođe loguje
 * jedan composite zapis ('catalogs_daily') sa zbirnim rows_updated.
 *
 * Locations job je u "best-effort" modu: ako padne (npr. zbog drugačije
 * sheme), composite job se ne abortuje — preostali katalozi su već gotovi.
 * Greška se loguje i propagira kroz sync_log za locations zasebno.
 */
export async function syncCatalogs() {
  const run = await startRun('catalogs_daily');
  log.info('start');
  let total = 0;
  let locationsOk = true;
  try {
    const d = await syncDepartments();
    total += d.total;
    const m = await syncMachines();
    total += m.total;
    const c = await syncCustomers();
    total += c.total;
    const w = await syncWorkers();
    total += w.total;

    try {
      const l = await syncLocations();
      total += l.total;
    } catch (locErr) {
      locationsOk = false;
      log.warn(
        { err: locErr?.message || locErr },
        'locations sync failed (non-fatal); pokreni `npm run discover:columns -- tLokacijeDelova` za debug',
      );
    }

    await finishRun(run, { rowsUpdated: total });
    log.info(
      { totalRows: total, locationsOk },
      locationsOk ? 'all 5 catalogs done' : '4/5 catalogs done (locations failed)',
    );
    return { total, locationsOk };
  } catch (err) {
    log.error({ err }, 'catalogs job failed');
    await failRun(run, err);
    throw err;
  }
}
