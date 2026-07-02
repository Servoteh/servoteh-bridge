/**
 * Normalizacija sirovih /api/* odgovora SCADA aplikacije u jedinstven oblik
 * za Supabase:
 *   { online: boolean,
 *     payload: object,                 → scada_snapshots.payload (ceo sirovi JSON)
 *     history: [{metric, value}],      → scada_history uzorci (long format)
 *     alarms:  [{code, severity, text}] → aktivni alarmi za scada_alarms diff-sync
 *   }
 *
 * payload čuvamo NEIZMENJEN (isti oblik kao lokalni UI), pa ServoSync ekrani
 * mogu da portuju postojeće rendere 1:1. history/alarms su izvedeni.
 */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// kot1 (Unitronics /api/state): values = { TAG: {value, raw, ts} }
const KOT1_HISTORY_TAGS = [
  'T_SPOLJA', 'T_SUDA', 'T_CNC', 'T_ZAVAR', 'T_MONTAZA1', 'T_MONTAZA2', 'T_HIDRAULIKA',
  'SP_SPOLJA', 'SP_SUDA_H', 'SP_SUDA_L', 'SP_CNC', 'SP_HIDRAULIKA', 'SP_MONTAZA', 'SP_ZAVAR',
];
const KOT1_ALARM_TAGS = [
  { tag: 'ALARM_PUMPE', severity: 2, text: 'Alarm toplotne pumpe' },
  { tag: 'ALARM_ZASTITE', severity: 2, text: 'Ispad zaštite' },
  { tag: 'ALARM_OUT', severity: 3, text: 'Zbirni alarm izlaz' },
];

export function normalizeKot1(raw) {
  const values = raw?.values || {};
  const online = raw?.online === true;
  const history = [];
  if (online) {
    for (const tag of KOT1_HISTORY_TAGS) {
      const v = num(values[tag]?.value);
      if (v != null) history.push({ metric: tag, value: v });
    }
  }
  const alarms = [];
  if (online) {
    for (const a of KOT1_ALARM_TAGS) {
      if (Number(values[a.tag]?.value) === 1) {
        alarms.push({ code: a.tag, severity: a.severity, text: a.text });
      }
    }
  }
  return { online, payload: raw ?? {}, history, alarms };
}

// kot2 (Siemens /api/s7): temps[], setpoint, alarms[] (samo aktivni, dekodirani iz reči)
export function normalizeKot2(raw) {
  const online = raw?.online === true;
  const history = [];
  if (online) {
    for (const t of raw?.temps || []) {
      const v = num(t?.value);
      if (v != null && !t?.fault) history.push({ metric: t.key, value: v });
    }
    const sp = num(raw?.setpoint);
    if (sp != null) history.push({ metric: 'setpoint', value: sp });
  }
  const alarms = (online ? raw?.alarms || [] : []).map((a) => ({
    code: `${a.word ?? 'W?'}.${a.bit ?? '?'}`,
    severity: a.sev === 'alarm' ? 2 : 3,
    text: a.text || `${a.word}.${a.bit}`,
  }));
  return { online, payload: raw ?? {}, history, alarms };
}

// kot3 (Loxone /api/loxone): tags[] (kind='room' ima states.tempActual uuid) + live {uuid: broj}
export function normalizeKot3(raw) {
  const online = raw?.wsReady === true || (Array.isArray(raw?.tags) && raw.tags.length > 0);
  const live = raw?.live || {};
  const values = raw?.values || {};
  const history = [];
  if (online) {
    for (const tag of raw?.tags || []) {
      if (tag?.kind !== 'room' || !tag?.states?.tempActual) continue;
      const uuid = tag.states.tempActual;
      const v = num(live[uuid]) ?? num(values[uuid]?.value);
      if (v != null && tag.room) history.push({ metric: `room:${tag.room}`, value: v });
    }
  }
  return { online, payload: raw ?? {}, history, alarms: [] };
}

// solar-kaco (blue'Log /api/bluelog): plant agregat + inverters[] + meter
export function normalizeKaco(raw) {
  const online = raw?.online === true;
  const history = [];
  if (online) {
    const kw = num(raw?.plant?.kw);
    if (kw != null) history.push({ metric: 'pv', value: kw });
    const kwhDay = num(raw?.plant?.kwhDay);
    if (kwhDay != null) history.push({ metric: 'e_day', value: kwhDay });
    const gridKw = num(raw?.meter?.pActive);
    if (gridKw != null) history.push({ metric: 'grid', value: gridKw / 1000 });
  }
  const alarms = [];
  const active = num(raw?.plant?.activeInverters);
  const reporting = num(raw?.plant?.reportingInverters);
  if (online && active != null && reporting != null && reporting < active) {
    alarms.push({
      code: 'INVERTER_OFFLINE',
      severity: 3,
      text: `Javlja se ${reporting}/${active} invertora`,
    });
  }
  return { online, payload: raw ?? {}, history, alarms };
}

// solar-sigen (/api/sigen): values = { systemId: { pvPower: {value,ts}, ... } }
const SIGEN_METRICS = [
  ['pvPower', 'pv'], ['loadPower', 'load'], ['gridPower', 'grid'],
  ['batteryPower', 'battery'], ['batterySoc', 'soc'],
];

export function normalizeSigen(raw) {
  const online = raw?.online === true;
  const history = [];
  if (online) {
    for (const [systemId, vals] of Object.entries(raw?.values || {})) {
      for (const [field, metric] of SIGEN_METRICS) {
        const v = num(vals?.[field]?.value);
        if (v != null) history.push({ metric: `${systemId}:${metric}`, value: v });
      }
    }
  }
  return { online, payload: raw ?? {}, history, alarms: [] };
}

export const NORMALIZERS = Object.freeze({
  kot1: normalizeKot1,
  kot2: normalizeKot2,
  kot3: normalizeKot3,
  'solar-kaco': normalizeKaco,
  'solar-sigen': normalizeSigen,
});
