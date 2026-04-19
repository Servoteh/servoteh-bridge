import { runQuery } from '../db/sqlserver.js';
import { upsertChunked } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';

const log = logJob('syncWorkers');

/**
 * KRITIČNO (sekcija 6.6 BIGTEHN_DATA_MAP.md):
 *   tRadnici sadrži plaintext kolone Password i PasswordRadnika.
 *   Ovaj SELECT ih EKSPLICITNO NE čita. Nikada ne dodavati.
 */
const SQL = `
  SELECT
    SifraRadnika                          AS id,
    LTRIM(RTRIM(ImeIPrezime))             AS full_name,
    LTRIM(RTRIM(Radnik))                  AS short_name,
    LTRIM(RTRIM(IDRadneJedinice))         AS department_id,
    LTRIM(RTRIM(IDKartice))               AS card_id,
    IDVrsteRadnika                        AS worker_type_id,
    ISNULL(Aktivan, 0)                    AS is_active
  FROM tRadnici
  WHERE SifraRadnika IS NOT NULL;
`;

function mapRow(row) {
  return {
    id: row.id,
    full_name: row.full_name || row.short_name || '(bez imena)',
    short_name: row.short_name || null,
    department_id: row.department_id || null,
    card_id: row.card_id || null,
    worker_type_id: row.worker_type_id ?? null,
    is_active: !!row.is_active,
    synced_at: new Date().toISOString(),
  };
}

export async function syncWorkers() {
  const run = await startRun('catalog_workers');
  log.info('start');
  try {
    const rows = await runQuery(SQL);
    log.info({ count: rows.length, active: rows.filter((r) => r.is_active).length }, 'fetched');

    const payload = rows.map(mapRow);
    const { total } = await upsertChunked('bigtehn_workers_cache', payload, 'id');

    await finishRun(run, { rowsUpdated: total });
    log.info({ upserted: total }, 'done');
    return { total };
  } catch (err) {
    log.error({ err }, 'failed');
    await failRun(run, err);
    throw err;
  }
}
