import sql from 'mssql';

import { config } from '../config.js';
import { logger } from '../logger.js';

let _pool = null;
let _connecting = null;

const sqlConfig = {
  server: config.bigtehn.server,
  port: config.bigtehn.port,
  database: config.bigtehn.database,
  user: config.bigtehn.user,
  password: config.bigtehn.password,
  options: {
    encrypt: config.bigtehn.encrypt,
    trustServerCertificate: config.bigtehn.trustServerCertificate,
    enableArithAbort: true,
  },
  requestTimeout: config.bigtehn.requestTimeout,
  connectionTimeout: config.bigtehn.connectionTimeout,
  pool: {
    min: config.bigtehn.poolMin,
    max: config.bigtehn.poolMax,
    idleTimeoutMillis: 30_000,
  },
};

/**
 * Vraća singleton pool. Ako pool nije konektovan, čeka konekciju.
 * Ako konekcija padne, sledeći poziv pravi novi pool.
 */
export async function getSqlPool() {
  if (_pool && _pool.connected) return _pool;
  if (_connecting) return _connecting;

  _connecting = (async () => {
    try {
      logger.info(
        { server: config.bigtehn.server, db: config.bigtehn.database, user: config.bigtehn.user },
        '[sqlserver] connecting',
      );
      const pool = new sql.ConnectionPool(sqlConfig);
      pool.on('error', (err) => {
        logger.error({ err }, '[sqlserver] pool error');
      });
      await pool.connect();
      _pool = pool;
      logger.info('[sqlserver] connected');
      return pool;
    } catch (err) {
      logger.error({ err }, '[sqlserver] connection failed');
      _pool = null;
      throw err;
    } finally {
      _connecting = null;
    }
  })();

  return _connecting;
}

export async function closeSqlPool() {
  if (_pool) {
    try {
      await _pool.close();
      logger.info('[sqlserver] pool closed');
    } catch (err) {
      logger.warn({ err }, '[sqlserver] pool close failed');
    } finally {
      _pool = null;
    }
  }
}

/**
 * Helper: izvrši SELECT i vrati `recordset` (niz redova kao plain objekti).
 * Pripremne (parametrizovane) upite — koristiti `request.input(...)`.
 */
export async function runQuery(text) {
  const pool = await getSqlPool();
  const result = await pool.request().query(text);
  return result.recordset || [];
}

export { sql };
