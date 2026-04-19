import 'dotenv/config';

function reqStr(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`[config] Nedostaje obavezna env varijabla: ${name}`);
  }
  return String(v).trim();
}

function optStr(name, fallback = '') {
  const v = process.env[name];
  return v == null ? fallback : String(v).trim();
}

function optInt(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function optBool(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

export const config = Object.freeze({
  bigtehn: Object.freeze({
    server: reqStr('BIGTEHN_SQL_SERVER'),
    port: optInt('BIGTEHN_SQL_PORT', 1433),
    database: reqStr('BIGTEHN_SQL_DATABASE'),
    user: reqStr('BIGTEHN_SQL_USER'),
    password: reqStr('BIGTEHN_SQL_PASSWORD'),
    encrypt: optBool('BIGTEHN_SQL_ENCRYPT', false),
    trustServerCertificate: optBool('BIGTEHN_SQL_TRUST_SERVER_CERTIFICATE', true),
    requestTimeout: optInt('BIGTEHN_SQL_REQUEST_TIMEOUT_MS', 60_000),
    connectionTimeout: optInt('BIGTEHN_SQL_CONNECTION_TIMEOUT_MS', 15_000),
    poolMin: optInt('BIGTEHN_SQL_POOL_MIN', 0),
    poolMax: optInt('BIGTEHN_SQL_POOL_MAX', 4),
  }),
  supabase: Object.freeze({
    url: reqStr('SUPABASE_URL').replace(/\/+$/, ''),
    serviceRoleKey: reqStr('SUPABASE_SERVICE_ROLE_KEY'),
  }),
  scheduler: Object.freeze({
    enabled: optBool('SCHEDULER_ENABLED', true),
    catalogsCron: optStr('SCHEDULE_CATALOGS_CRON', '0 6 * * *'),
    productionCron: optStr('SCHEDULE_PRODUCTION_CRON', '*/15 * * * *'),
    /* F.5a: BigTehn crteži — default jednom dnevno u 7:00 (30 min posle catalogs).
       Crteži se retko menjaju, nema potrebe za češćim sync-om. */
    drawingsCron: optStr('SCHEDULE_DRAWINGS_CRON', '0 7 * * *'),
    timezone: optStr('TZ', 'Europe/Belgrade'),
  }),
  logger: Object.freeze({
    level: optStr('LOG_LEVEL', 'info'),
    dir: optStr('LOG_DIR', 'logs'),
    pretty: optBool('LOG_PRETTY', false),
  }),
  alerts: Object.freeze({
    telegramBotToken: optStr('ALERT_TELEGRAM_BOT_TOKEN', ''),
    telegramChatId: optStr('ALERT_TELEGRAM_CHAT_ID', ''),
    webhookUrl: optStr('ALERT_WEBHOOK_URL', ''),
  }),
  instanceName: optStr('BRIDGE_INSTANCE_NAME', 'servoteh-bridge'),
  /* F.5a: Folder na BigBit serveru sa PDF crtežima (npr. C:\PDMExport\PDFImportovano).
     Ako je prazno, syncBigtehnDrawings job se preskoči (nije fail). */
  bigtehnDrawingsDir: optStr('BIGTEHN_DRAWINGS_DIR', ''),
});

export function describeConfig() {
  return {
    instance: config.instanceName,
    bigtehn: {
      server: config.bigtehn.server,
      port: config.bigtehn.port,
      database: config.bigtehn.database,
      user: config.bigtehn.user,
      encrypt: config.bigtehn.encrypt,
    },
    supabase: {
      url: config.supabase.url,
      serviceKeyLen: config.supabase.serviceRoleKey.length,
    },
    scheduler: { ...config.scheduler },
    logger: { level: config.logger.level, dir: config.logger.dir, pretty: config.logger.pretty },
  };
}
