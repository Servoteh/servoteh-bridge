import { runQuery } from '../db/sqlserver.js';
import { upsertChunked } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';

const log = logJob('syncLocations');

/**
 * VAŽNO — pretpostavljena shema (BIGTEHN_DATA_MAP.md sekcija 5 ne specificira
 * tačne kolone za tLokacijeDelova, samo spominje upotrebu u sekciji 3.1).
 *
 * Ako prvi run padne sa "Invalid column name X" — pokreni:
 *   npm run discover:columns -- tLokacijeDelova
 * pa ažuriraj SQL ispod prema stvarnim kolonama.
 *
 * Najverovatnije BigTehn imenovanje (na osnovu konvencije: tRadneJedinice,
 * tOperacije, tRadnici):
 *   IDLokacije, SifraLokacije, NazivLokacije, IDRadneJedinice, Aktivan
 *
 * Alternativna imena koja sam video u sličnim BigTehn instalacijama:
 *   ID, Sifra, Naziv, Tip, VrstaLokacije
 */
const SQL = `
  SELECT
    IDLokacije                       AS id,
    LTRIM(RTRIM(SifraLokacije))      AS code,
    LTRIM(RTRIM(NazivLokacije))      AS name,
    LTRIM(RTRIM(IDRadneJedinice))    AS department_id,
    ISNULL(Aktivan, 0)               AS is_active
  FROM tLokacijeDelova
  WHERE IDLokacije IS NOT NULL;
`;

function mapRow(row) {
  return {
    id: row.id,
    code: row.code || `(loc-${row.id})`,
    name: row.name || null,
    department_id: row.department_id || null,
    is_active: !!row.is_active,
    synced_at: new Date().toISOString(),
  };
}

export async function syncLocations() {
  const run = await startRun('catalog_locations');
  log.info('start');
  try {
    const rows = await runQuery(SQL);
    log.info(
      { count: rows.length, active: rows.filter((r) => r.is_active).length },
      'fetched from BigTehn',
    );

    const payload = rows.map(mapRow);
    const { total } = await upsertChunked('bigtehn_locations_cache', payload, 'id');

    await finishRun(run, { rowsUpdated: total });
    log.info({ upserted: total }, 'done');
    return { total };
  } catch (err) {
    log.error({ err }, 'failed');
    await failRun(run, err);
    throw err;
  }
}
