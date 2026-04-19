import { logJob } from '../logger.js';
import { syncWorkOrderApprovals } from './syncWorkOrderApprovals.js';
import { syncWorkOrderLaunches } from './syncWorkOrderLaunches.js';
import { syncWorkOrderLines } from './syncWorkOrderLines.js';
import { syncWorkOrders } from './syncWorkOrders.js';
import { failRun, finishRun, startRun } from './syncLog.js';

const log = logJob('syncProduction');

/**
 * Composite production sync — pokreće sva 4 incremental joba.
 *
 * Redosled (FK redosled da bismo izbegli orphan redove u UI-u):
 *   1) syncWorkOrders        (tRN)              — parent
 *   2) syncWorkOrderLines    (tStavkeRN)         — FK -> tRN
 *   3) syncWorkOrderLaunches (tLansiranRN)       — FK -> tRN
 *   4) syncWorkOrderApprovals (tSaglasanRN)      — FK -> tRN
 *
 * Pokreće se cron-om svakih 15 minuta. Tipično traje <5 sekundi po runu
 * (samo izmenjeni redovi zahvaljujući watermark-u).
 *
 * Fail strategija: ako jedan job pukne, zaustavljamo se (parent run je
 * "failed"), ali pojedinačni jobovi koji su prošli su već zabeleženi kao
 * uspešni u bridge_sync_log (zbog start/finish/failRun po jobu).
 */
export async function syncProduction() {
  const run = await startRun('production_15min');
  log.info('start (composite, 4 jobs)');
  let total = 0;
  try {
    const wo = await syncWorkOrders();
    total += wo.total;

    const lines = await syncWorkOrderLines();
    total += lines.total;

    const launches = await syncWorkOrderLaunches();
    total += launches.total;

    const approvals = await syncWorkOrderApprovals();
    total += approvals.total;

    await finishRun(run, { rowsUpdated: total });
    log.info(
      {
        totalRows: total,
        breakdown: {
          work_orders: wo.total,
          lines: lines.total,
          launches: launches.total,
          approvals: approvals.total,
        },
      },
      'production sync done',
    );
    return { total };
  } catch (err) {
    log.error({ err }, 'production sync failed');
    await failRun(run, err);
    throw err;
  }
}
