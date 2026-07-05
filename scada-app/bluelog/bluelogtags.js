// Tag-mapa solarne elektrane (FNE SERVOTEH) sa blue'Log-a.
// Plant: 6× KACO blueplanet 50.0 TL3 (invertori) + Janitza UMG 96RM (brojilo na mrežnom spoju).
// Snaga postrojenja = SUMA P_AC svih invertora; dnevni prinos = SUMA E_DAY.
// Vrednosti: POST /device/values  (epoch-ms dateRange; vidi bluelog.js).
//
// Abbreviation-i (POST /device/abbreviations):
//   INVERTOR (KACO): P_AC[W], P_DC[W], E_DAY[Wh], T[°C], U_DC1/I_DC1, U_AC1-3/I_AC1-3, COS_PHI, STATE1
//   BROJILO (Janitza UMG 96RM): M_AC_P[W] aktivna, M_AC_Q[var] reaktivna, M_AC_S[VA] prividna,
//     M_AC_PF_COSPHI faktor, M_AC_F[Hz], M_AC_U1-3[V], M_AC_I1-3[A], M_AC_E_EXP/E_IMP[Wh] brojači.

const INVERTER_ABBRS = ['P_AC', 'P_DC', 'E_DAY', 'T'];
const METER_ABBRS = [
  'M_AC_P', 'M_AC_Q', 'M_AC_S', 'M_AC_PF_COSPHI', 'M_AC_F',
  'M_AC_U1', 'M_AC_U2', 'M_AC_U3', 'M_AC_I1', 'M_AC_I2', 'M_AC_I3',
  'M_AC_E_EXP', 'M_AC_E_IMP',
];

// Iz liste uređaja (GET /plant/scada-get-devices) izvuci ono što pollujemo.
function buildBlueLogTags(devices) {
  const inverters = (devices || [])
    .filter(d => d.type === 'INVERTER')
    .map(d => ({ id: d.id, name: d.name, vendor: d.vendor, model: d.model, address: d.address }))
    .sort((a, b) => (a.address || 0) - (b.address || 0));
  const meterDev = (devices || []).find(d => d.type === 'METER') || null;
  return {
    inverters,
    inverterIds: inverters.map(d => d.id),
    meter: meterDev ? { id: meterDev.id, name: meterDev.name, vendor: meterDev.vendor, model: meterDev.model } : null,
    inverterAbbrs: INVERTER_ABBRS,
    meterAbbrs: METER_ABBRS,
  };
}

const num = (v) => (typeof v === 'number' ? v : null);

// latestInv = {invId:{P_AC,P_DC,E_DAY,T,_ts}}   latestMeter = {meterId:{M_AC_*,_ts}}
function normalize(map, latestInv, latestMeter) {
  const inverters = map.inverters.map(d => {
    const v = (latestInv && latestInv[d.id]) || {};
    const pAc = num(v.P_AC);
    return {
      id: d.id, name: d.name, address: d.address, model: d.model,
      pAc,                                   // W (AC)
      pDc: num(v.P_DC),                      // W (DC)
      eDay: num(v.E_DAY),                    // Wh danas
      temp: num(v.T),                        // °C
      online: pAc !== null,
      ts: v._ts || null,
    };
  });
  const withPower = inverters.filter(x => x.pAc !== null);
  const pPlant = withPower.reduce((s, x) => s + x.pAc, 0);
  const eDayPlant = inverters.reduce((s, x) => s + (x.eDay || 0), 0);

  let meter = null;
  if (map.meter) {
    const m = (latestMeter && latestMeter[map.meter.id]) || {};
    meter = {
      name: map.meter.name, model: map.meter.model,
      pActive: num(m.M_AC_P),                // W
      pReactive: num(m.M_AC_Q),              // var
      pApparent: num(m.M_AC_S),              // VA
      pf: num(m.M_AC_PF_COSPHI),
      freq: num(m.M_AC_F),                   // Hz
      u: [num(m.M_AC_U1), num(m.M_AC_U2), num(m.M_AC_U3)],   // V
      i: [num(m.M_AC_I1), num(m.M_AC_I2), num(m.M_AC_I3)],   // A
      eExp: num(m.M_AC_E_EXP),               // Wh (brojač)
      eImp: num(m.M_AC_E_IMP),               // Wh (brojač)
      online: num(m.M_AC_P) !== null,
      ts: m._ts || null,
    };
  }

  return {
    plant: {
      pAc: Math.round(pPlant),               // W (suma invertora)
      kw: Math.round(pPlant / 10) / 100,     // kW
      eDay: Math.round(eDayPlant),           // Wh danas
      kwhDay: Math.round(eDayPlant / 10) / 100,  // kWh danas
      unit: 'W',
      activeInverters: inverters.filter(x => (x.pAc || 0) > 0).length,
      reportingInverters: withPower.length,
      count: inverters.length,
    },
    inverters,
    meter,
  };
}

module.exports = { buildBlueLogTags, normalize, INVERTER_ABBRS, METER_ABBRS };
