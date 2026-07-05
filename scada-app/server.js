// Kotlarnica SCADA - backend (Unitronics PCOM/TCP master + REST + WebSocket)
// Pokretanje:  npm install  &&  npm start
// Env:
//   PLC_IP   (default 192.168.75.25)  PLC_PORT (502)  PLC_UNIT (1)
//   SIMULATE ("false" = pravi PLC, "true" = lazni podaci)   HTTP_PORT (3000)

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Pcom } = require('./pcom');
const { TAGS, ZONES } = require('./tags');
const history = require('./history');
const notifier = require('./notifier');
const fs = require('fs');
const { Loxone } = require('./loxone/loxone');
const { buildLoxoneTags, loxCommand } = require('./loxone/loxtags');
const { LoxWS } = require('./loxone/loxws');
const { Sigen, SigenRateLimit, SigenTransient, SWITCHABLE_MODES } = require('./sigen/sigen');
const { SIG_TAGS, flattenSigen, modeOptions } = require('./sigen/sigtags');
const { BlueLog } = require('./bluelog/bluelog');
const { buildBlueLogTags, normalize: blNormalize } = require('./bluelog/bluelogtags');
const { S7Web } = require('./s7/s7web');
const { flattenS7, validateWrite } = require('./s7/s7tags');

// minimalni .env loader (bez dependency-ja) — postavi env samo ako nije već zadat
try {
  require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* nema .env — koristi env/podrazumevane */ }

const CFG = {
  plcIp:   process.env.PLC_IP   || '192.168.75.25',
  plcPort: parseInt(process.env.PLC_PORT || '502', 10),
  plcUnit: parseInt(process.env.PLC_UNIT || '1', 10),
  simulate: (process.env.SIMULATE || 'false').toLowerCase() === 'true',
  httpPort: parseInt(process.env.HTTP_PORT || '3000', 10),
  pollMs: 1000,
};

const state = {};
let plcOnline = false;
let plc = null;

let plcConnecting = false, plcNextTry = 0;
async function ensureConnected() {
  if (CFG.simulate) return false;
  if (plc && plc.connected) return true;
  if (plcConnecting || Date.now() < plcNextTry) return false;  // jedan pokušaj odjednom + backoff
  plcConnecting = true;
  try {
    plc = new Pcom(CFG.plcIp, CFG.plcPort, CFG.plcUnit);
    await plc.connect();
    plcOnline = true;
    console.log(`[PLC] PCOM povezan na ${CFG.plcIp}:${CFG.plcPort}`);
    return true;
  } catch (e) {
    plcOnline = false;
    plcNextTry = Date.now() + 8000;  // sačekaj 8s pre sledećeg pokušaja (ne gušiti Jazz)
    console.warn(`[PLC] veza neuspesna: ${e.message}`);
    return false;
  } finally {
    plcConnecting = false;
  }
}

function setRaw(t, raw) {
  const value = (t.scale && raw !== null) ? raw / t.scale : raw;
  state[t.name] = { value, raw, ts: Date.now() };
}
// satnice su BCD u 16-bit registru: high byte = sati (BCD), low byte = minuti (BCD)
function bcdToHHMM(raw) {
  const h = ((raw >> 12) & 0xf) * 10 + ((raw >> 8) & 0xf);
  const m = ((raw >> 4) & 0xf) * 10 + (raw & 0xf);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
function hhmmToBcd(s) {
  const [h, m] = String(s).split(':').map(x => parseInt(x, 10) || 0);
  return ((Math.floor(h / 10) & 0xf) << 12) | ((h % 10) << 8) | ((Math.floor(m / 10) & 0xf) << 4) | (m % 10);
}
function setSchedTime(t, raw) { state[t.name] = { value: bcdToHHMM(raw), raw, ts: Date.now() }; }

// ---------- ZIVO citanje (PCOM batch) ----------
async function readLive() {
  const mi = await plc.readWords(20, 44);        // MI20..63
  const mb = await plc.readBits('RB', 0, 27);    // MB0..26
  const di = await plc.readBits('RE', 0, 16);    // I0..15
  const ou = await plc.readBits('RA', 0, 19);    // O0..18
  for (const t of TAGS) {
    let raw = null;
    if (t.type === 'MI') raw = (t.addr >= 20 && t.addr <= 63) ? mi[t.addr - 20] : null;
    else if (t.type === 'MB') raw = mb[t.addr];
    else if (t.type === 'I')  raw = di[t.addr];
    else if (t.type === 'O')  raw = ou[t.addr];
    if (raw !== undefined && raw !== null) {
      if (t.kind === 'schedtime') setSchedTime(t, raw);
      else setRaw(t, raw);
    }
  }
}

async function writeTag(t, value) {
  if (CFG.simulate) {
    if (t.kind === 'schedtime') setSchedTime(t, hhmmToBcd(value));
    else setRaw(t, value);
    if (t.kind === 'cmd') setTimeout(() => setRaw(t, 0), 600);
    return;
  }
  if (!(await ensureConnected())) throw new Error('PLC nije dostupan');
  if (t.type === 'MI') {
    if (t.kind === 'schedtime') await plc.writeWord(t.addr, hhmmToBcd(value));
    else await plc.writeWord(t.addr, Math.round(value));
  } else if (t.type === 'MB') {
    await plc.writeBit('SB', t.addr, value);
  } else if (t.type === 'O') {
    await plc.writeBit('SA', t.addr, value);
    if (t.kind === 'cmd') setTimeout(() => plc.writeBit('SA', t.addr, 0).catch(() => {}), 600);
  }
}

// ---------- Simulacija ----------
const sim = { tick: 0 };
function heatDemand(zone) {
  const tt = tempFor(zone);
  const sp = state[setpointFor(zone)]?.value ?? 22;
  return tt !== null && tt < sp - 0.3 ? 1 : 0;
}
function simulateAll() {
  sim.tick++;
  for (const t of TAGS) {
    if (t.kind === 'setpoint' || t.kind === 'mode' || t.kind === 'manual' || t.kind === 'schedday') {
      if (state[t.name] === undefined) setRaw(t, defaultVal(t));
      continue;
    }
    if (t.kind === 'schedtime') {
      if (state[t.name] === undefined) setSchedTime(t, defaultSched(t));
      continue;
    }
    if (t.kind === 'temp') {
      const sp = state[setpointFor(t.zone)]?.value ?? 22;
      const wobble = Math.sin((sim.tick + t.addr) / 12) * 1.5;
      const v = (t.zone === 'SPOLJA') ? 8 + Math.sin(sim.tick / 30) * 4 : sp + wobble;
      setRaw(t, Math.round(v * t.scale));
    } else if (t.kind === 'device' || t.kind === 'zoneout') {
      setRaw(t, heatDemand(t.zone));
    } else if (t.kind === 'alarm') {
      setRaw(t, 0);
    } else if (t.kind === 'cmd') {
      if (state[t.name] === undefined) setRaw(t, 0);
    } else if (t.kind === 'swinput') {
      setRaw(t, 1);
    } else {
      setRaw(t, ['KOTAO_RAD','TOPLOTNA_PUMPA','FREKVENTNI_RUN','PREKIDAC_ONOFF'].includes(t.name) ? 1 : 0);
    }
  }
}
function defaultVal(t) {
  if (t.kind === 'mode')     return (t.name === 'AUTO_MAN' || t.name === 'GREJ_HLAD') ? 1 : 0;
  if (t.kind === 'manual')   return 0;
  if (t.kind === 'schedday') return 1;
  const d = { SP_SPOLJA:18, SP_SUDA_H:80, SP_SUDA_L:60, SP_HIDRAULIKA:21,
              SP_CNC:20, SP_ZAVAR:19, SP_MONTAZA:21 };
  return (d[t.name] ?? 21) * (t.scale || 1);
}
function defaultSched(t) {
  const d = { T_PONPET_ON:0x0600, T_PONPET_OFF:0x1800, T_SUBNED_ON:0x0700, T_SUBNED_OFF:0x2200 };
  return d[t.name] ?? 0x0600;
}
function setpointFor(zone) {
  const m = { SPOLJA:'SP_SPOLJA', SUDA:'SP_SUDA_H', HIDRAULIKA:'SP_HIDRAULIKA',
              CNC:'SP_CNC', ZAVARIVANJE:'SP_ZAVAR', MONTAZA:'SP_MONTAZA' };
  return m[zone];
}
function tempFor(zone) {
  const t = TAGS.find(x => x.zone === zone && x.kind === 'temp');
  return t ? (state[t.name]?.value ?? null) : null;
}

// ---------- Poll ----------
const prevAlarm = {};
function checkAlarms() {
  for (const t of TAGS) {
    if (t.kind !== 'alarm') continue;
    const on = !!(state[t.name] && state[t.name].value);
    if (on && !prevAlarm[t.name]) notifier.alarm(t.name, t.label);  // edge 0->1
    prevAlarm[t.name] = on;
  }
}

async function poll() {
  if (CFG.simulate) { simulateAll(); }
  else if (await ensureConnected()) {
    try { await readLive(); plcOnline = true; }
    catch (e) { plcOnline = false; console.warn('[PLC] greska citanja: ' + e.message); plc && plc.close(); }
  }
  history.record(TAGS, state);
  checkAlarms();
  broadcast();
}

// ---------- HTTP + WS ----------
const app = express();
app.use(express.json());
// Overview je početna; Kotlarnica (stari index.html) na /kotlarnica. (mora PRE static)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'overview.html')));
app.get('/kotlarnica', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/tags', (req, res) => res.json({ tags: TAGS, zones: ZONES, online: plcOnline, simulate: CFG.simulate }));
app.get('/api/state', (req, res) => res.json(snapshot()));
app.get('/api/history', (req, res) => res.json({
  tags: TAGS.filter(t => t.kind === 'temp' || t.kind === 'setpoint')
            .map(t => ({ name: t.name, label: t.label, kind: t.kind, zone: t.zone })),
  series: history.get(),
}));
app.post('/api/write', async (req, res) => {
  const { name, value } = req.body || {};
  const t = TAGS.find(x => x.name === name);
  if (!t) return res.status(404).json({ error: 'nepoznat tag' });
  if (t.access !== 'rw') return res.status(403).json({ error: 'tag je samo za citanje' });
  try {
    const raw = t.scale ? Math.round(value * t.scale) : value;
    await writeTag(t, raw);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function snapshot() {
  const out = {};
  for (const t of TAGS) out[t.name] = state[t.name] || { value: null, raw: null };
  return { values: out, online: CFG.simulate ? true : plcOnline, simulate: CFG.simulate };
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
function broadcast() {
  const msg = JSON.stringify({ type: 'state', ...snapshot() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'state', ...snapshot() }));
  if (lox) ws.send(JSON.stringify({ type: 'loxone', ...loxSnapshot() }));
  if (sigen) ws.send(JSON.stringify({ type: 'sigen', ...sigSnapshot() }));
  if (bl) ws.send(JSON.stringify({ type: 'bluelog', ...blSnapshot() }));
  if (s7) ws.send(JSON.stringify({ type: 's7', ...s7Snapshot() }));
});

// ---------- LOXONE (Nova zgrada) — opciono, ako je LOXONE_HOST zadat ----------
let lox = null, loxTags = [], loxState = {}, loxws = null;
function loxInit() {
  if (!process.env.LOXONE_HOST) return;
  lox = new Loxone(process.env.LOXONE_HOST, process.env.LOXONE_USER, process.env.LOXONE_PASS);
  try {
    const struct = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'loxone-structure.json'), 'utf8'));
    loxTags = buildLoxoneTags(struct);
    console.log(`[Loxone] ${loxTags.length} tagova @ ${process.env.LOXONE_HOST}`);
  } catch (e) {
    console.warn('[Loxone] nema strukture (pokreni: npm run loxone:discover): ' + e.message);
  }
  // WebSocket za ŽIVO stanje svih state-UUID-eva (temp, brzina, režim po sobi)
  loxws = new LoxWS(process.env.LOXONE_HOST, process.env.LOXONE_USER, process.env.LOXONE_PASS);
  loxws.start();
}
async function loxPoll() {
  if (!lox || !loxTags.length) return;
  for (let i = 0; i < loxTags.length; i += 8) {            // u grupama po 8 (paralelno)
    await Promise.all(loxTags.slice(i, i + 8).map(async t => {
      try { loxState[t.key] = { value: await lox.state(t.uuid), ts: Date.now() }; } catch (e) {}
    }));
  }
  const msg = JSON.stringify({ type: 'loxone', ...loxSnapshot() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
function loxSnapshot() {
  return {
    tags: loxTags, values: loxState,
    live: loxws ? loxws.values : {},        // uuid(state) -> vrednost (WebSocket, živo)
    wsReady: loxws ? loxws.ready : false,
    host: process.env.LOXONE_HOST || null,
  };
}

// ---------- SIGENERGY (solarna elektrana, Cloud OpenAPI) — opciono, VIŠE SISTEMA ----------
// SIGEN_SYSTEM_ID može biti lista odvojena zarezom (npr. dve Servoteh FNE).
// Rate-limit: 1 zahtev po endpointu/5min -> poll na SIGEN_POLL_MS (default 300000).
// Po sistemu 3 endpointa; svaki systemId je zaseban put pa se limit broji odvojeno.
let sigen = null, sigSystemIds = [], sigSystems = [], sigStates = {}, sig_lastRaw = {};
let sigHist = {};   // ring buffer dnevne krive po sistemu: [{t,pv,lo,gr,ba,soc}] (Power Metrics grafik)
let sigOnline = false, sigErr = null;
// Kontrola je default ISKLJUČENA: njihov OpenAPI katalog trenutno nema kontrolne
// endpointe (Control = prazno). Kad Sigenergy odobri kontrolu -> SIGEN_CONTROL=true.
const sigControl = (process.env.SIGEN_CONTROL || 'false').toLowerCase() === 'true';
function sigInit() {
  sigSystemIds = (process.env.SIGEN_SYSTEM_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  const haveKey = process.env.SIGEN_APP_KEY && process.env.SIGEN_APP_SECRET;
  const havePass = process.env.SIGEN_USER && process.env.SIGEN_PASS;
  if (!sigSystemIds.length || (!haveKey && !havePass)) return;   // nije konfigurisan
  sigen = new Sigen({
    region: process.env.SIGEN_REGION || 'eu',
    authMethod: haveKey ? 'key' : 'password',
    appKey: process.env.SIGEN_APP_KEY,
    appSecret: process.env.SIGEN_APP_SECRET,
    username: process.env.SIGEN_USER,
    password: process.env.SIGEN_PASS,
  });
  sigSystems = sigSystemIds.map(id => ({ systemId: id, name: id }));
  // imena sistema (jednokratno) — ne ruši poll ako padne
  sigen.getSystemList().then(list => {
    const byId = {};
    for (const s of list) byId[s.systemId || s.id || s.installationId] = s.systemName || s.name;
    sigSystems = sigSystemIds.map(id => ({ systemId: id, name: byId[id] || id }));
  }).catch(() => {});
  console.log(`[Sigen] OpenAPI (${process.env.SIGEN_REGION || 'eu'}) ${sigSystemIds.length} sistem(a), poll ${sigPollMs() / 1000}s`);
}
function sigPollMs() { return Math.max(60000, parseInt(process.env.SIGEN_POLL_MS || '300000', 10)); }
async function sigPollOne(id) {
  const prev = sig_lastRaw[id] || { flow: {}, sum: {}, mode: null };
  // kreni od prethodnih vrednosti -> rate-limit/transient prirodno zadrži poslednje dobre
  const out = { flow: prev.flow || {}, sum: prev.sum || {}, mode: prev.mode ?? null };
  const soft = e => (e instanceof SigenTransient) || (e instanceof SigenRateLimit);
  try { out.flow = await sigen.getEnergyFlow(id); } catch (e) { if (!soft(e)) sigErr = e.message; }
  try { out.sum = await sigen.getSummary(id); }     catch (e) { if (!soft(e)) sigErr = e.message; }
  try { out.mode = await sigen.getOperatingMode(id); } catch (e) { if (!soft(e)) sigErr = e.message; }
  const has = Object.keys(out.flow).length > 0 || Object.keys(out.sum).length > 0 || out.mode != null;
  if (has) {
    sigStates[id] = flattenSigen(out); sig_lastRaw[id] = out;
    const v = sigStates[id], h = (sigHist[id] = sigHist[id] || []);
    h.push({ t: Date.now(), pv: v.pvPower ?? null, lo: v.loadPower ?? null, gr: v.gridPower ?? null, ba: v.batteryPower ?? null, soc: v.batterySoc ?? null });
    if (h.length > 600) h.shift();   // ~50h pri 5-min pollu
  }
  return has;
}
async function sigPoll() {
  if (!sigen || !sigSystemIds.length) return;
  let okAny = false;
  for (const id of sigSystemIds) { if (await sigPollOne(id)) okAny = true; }
  sigOnline = okAny;
  if (okAny) sigErr = null;
  const msg = JSON.stringify({ type: 'sigen', ...sigSnapshot() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
function sigSnapshot() {
  return { tags: SIG_TAGS, modes: modeOptions(), systems: sigSystems,
           values: sigStates, online: sigOnline, error: sigErr, control: sigControl };
}

app.get('/api/sigen', (req, res) => res.json(sigSnapshot()));
app.get('/api/sigen/history', (req, res) => {
  const sys = req.query.system;
  res.json({ samples: sys ? (sigHist[sys] || []) : sigHist, pollMs: sigPollMs() });
});
app.post('/api/sigen/write', async (req, res) => {
  if (!sigen) return res.status(503).json({ error: 'Sigenergy nije konfigurisan' });
  if (!sigControl) return res.status(403).json({ error: 'kontrola je isključena (SIGEN_CONTROL=false) — cloud nema kontrolne endpointe' });
  const { systemId, mode } = req.body || {};
  const id = systemId || sigSystemIds[0];
  if (!sigSystemIds.includes(id)) return res.status(404).json({ error: 'nepoznat systemId' });
  if (!(Number(mode) in SWITCHABLE_MODES)) return res.status(400).json({ error: 'nedozvoljen režim (samo 0 ili 5)' });
  try {
    await sigen.setOperatingMode(id, Number(mode));
    sigStates[id] = flattenSigen({ ...(sig_lastRaw[id] || {}), mode: Number(mode) });
    if (sig_lastRaw[id]) sig_lastRaw[id].mode = Number(mode);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/loxone', (req, res) => res.json(loxSnapshot()));
app.post('/api/loxone/write', async (req, res) => {
  const { key, value } = req.body || {};
  const t = loxTags.find(x => x.key === key);
  if (!t) return res.status(404).json({ error: 'nepoznat tag' });
  if (!t.writable) return res.status(403).json({ error: 'read-only' });
  try { const r = await lox.command(t.uuid, loxCommand(t, value)); res.json({ ok: true, code: r.Code }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Zadavanje CILJ temperature u sobi (IRoomControllerV2): mode 'heat'|'cool'
app.post('/api/loxone/roomtemp', async (req, res) => {
  const { key, mode, value } = req.body || {};
  const t = loxTags.find(x => x.key === key && x.type === 'IRoomControllerV2');
  if (!t) return res.status(404).json({ error: 'nije sobni regulator' });
  const v = Number(value);
  if (!(v >= 5 && v <= 35)) return res.status(400).json({ error: 'temperatura van opsega 5–35' });
  const cmd = (mode === 'cool' ? 'setComfortTemperatureCool' : 'setComfortTemperature') + '/' + v;
  try { const r = await lox.command(t.uuid, cmd); res.json({ ok: true, code: r.Code }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- blue'Log (Solarna elektrana FNE SERVOTEH, meteocontrol X-Control) — opciono, ako je BLUELOG_HOST zadat ----------
// Lokalni REST koji koristi web "cockpit" (NEZVANIČAN privatni API; vidi bluelog/bluelog.js). Read-only.
// Prijava: POST /login {username, password:MD5}. Žive vrednosti: POST /device/values (1-min rezolucija).
// Snaga postrojenja = suma P_AC svih invertora. Pri firmware update-u proveri: npm run bluelog:discover.
let bl = null, blMap = null, blState = {}, blInfo = null, blOnline = false, blErr = null;
let blHist = [];   // ring buffer PV krive dana (Power Metrics grafik)
function blPollMs() { return Math.max(15000, parseInt(process.env.BLUELOG_POLL_MS || '30000', 10)); }
function blInit() {
  if (!process.env.BLUELOG_HOST) return;
  if (!process.env.BLUELOG_USER || !process.env.BLUELOG_PASS) {
    console.warn("[blue'Log] BLUELOG_HOST zadat ali fali BLUELOG_USER/PASS — preskačem.");
    return;
  }
  bl = new BlueLog(process.env.BLUELOG_HOST, process.env.BLUELOG_USER, process.env.BLUELOG_PASS);
  console.log(`[blue'Log] @ ${process.env.BLUELOG_HOST}, poll ${blPollMs() / 1000}s`);
}
async function blPoll() {
  if (!bl) return;
  try {
    if (!bl.loggedIn) { await bl.login(); blInfo = await bl.info().catch(() => null); console.log("[blue'Log] prijavljen"); }
    if (!blMap || !blMap.inverterIds.length) {                      // jednom: lista uređaja
      blMap = buildBlueLogTags(await bl.getDevices());
      console.log(`[blue'Log] ${blMap.inverters.length} invertora${blMap.meter ? ' + brojilo' : ''}`);
    }
    const latestInv = await bl.latestValues(blMap.inverterIds, blMap.inverterAbbrs, { minutes: 15 });
    const latestMeter = blMap.meter ? await bl.latestValues([blMap.meter.id], blMap.meterAbbrs, { minutes: 15 }) : {};
    blState = blNormalize(blMap, latestInv, latestMeter);
    blOnline = true; blErr = null;
    const bp = blState.plant || {}, bm = blState.meter || {}, bnow = Date.now(), blast = blHist[blHist.length - 1];
    if (!blast || bnow - blast.t >= 55000) {
      blHist.push({ t: bnow, pv: bp.kw ?? null, gr: (bm.pActive != null ? bm.pActive / 1000 : null) });
      if (blHist.length > 2000) blHist.shift();
    }
  } catch (e) {
    blOnline = false; blErr = e.message;
    console.warn("[blue'Log] " + e.message);
  }
  const msg = JSON.stringify({ type: 'bluelog', ...blSnapshot() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
function blSnapshot() {
  return { online: blOnline, error: blErr, host: process.env.BLUELOG_HOST || null,
           plantName: blInfo && blInfo.loggerName, model: blInfo && blInfo.model,
           ...blState };
}
app.get('/api/bluelog', (req, res) => res.json(blSnapshot()));
app.get('/api/bluelog/history', (req, res) => res.json({ samples: blHist, pollMs: blPollMs() }));

// ---------- SIEMENS HALA 5 (S7-1200, AWP web most) — opciono ----------
// Aktivira se ako je S7_HOST zadat. READ svakih S7_POLL_MS (default 5s) preko web servera;
// WRITE preko /api/s7/write (whitelist). Bez izmena na PLC-u (Faza 1).
let s7 = null, s7State = {}, s7Online = false, s7Err = null;
function s7PollMs() { return Math.max(2000, parseInt(process.env.S7_POLL_MS || '5000', 10)); }
function s7Init() {
  if (!process.env.S7_HOST) return;
  s7 = new S7Web(process.env.S7_HOST, process.env.S7_USER || 'admin', process.env.S7_PASS || 'admin');
  console.log(`[S7 Hala5] AWP web @ ${process.env.S7_HOST}, poll ${s7PollMs() / 1000}s`);
}
async function s7Poll() {
  if (!s7) return;
  try {
    s7State = flattenS7(await s7.readAll());
    s7Online = true; s7Err = null;
  } catch (e) { s7Online = false; s7Err = e.message; }
  const msg = JSON.stringify({ type: 's7', ...s7Snapshot() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
function s7Snapshot() {
  return { host: process.env.S7_HOST || null, online: s7Online, error: s7Err, ...s7State };
}
app.get('/api/s7', (req, res) => res.json(s7Snapshot()));
app.post('/api/s7/write', async (req, res) => {
  if (!s7) return res.status(503).json({ error: 'Hala 5 (S7) nije konfigurisana' });
  const { tag, value } = req.body || {};
  let cmd;
  try { cmd = validateWrite(tag, value); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    await s7.write(cmd.tag, cmd.value);
    setTimeout(() => { s7Poll().catch(() => {}); }, 700);   // brzo osveži stanje posle upisa
    res.json({ ok: true, tag: cmd.tag, value: cmd.value });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

server.listen(CFG.httpPort, () => {
  console.log(`\n  KOTLARNICA SCADA -> http://localhost:${CFG.httpPort}`);
  console.log(`  Mod: ${CFG.simulate ? 'SIMULACIJA' : `PRAVI PLC (PCOM) ${CFG.plcIp}:${CFG.plcPort}`}`);
  console.log(`  Telegram alarmi: ${notifier.configured() ? 'aktivni' : 'isključeni (nema tokena)'}\n`);
  history.load();
  setInterval(poll, CFG.pollMs);
  poll();
  setInterval(() => history.save(), 5 * 60 * 1000);  // periodični upis istorije
  loxInit();
  if (lox) { loxPoll(); setInterval(loxPoll, 8000); console.log('[Loxone] poll svakih 8s'); }
  sigInit();
  if (sigen) { sigPoll(); setInterval(sigPoll, sigPollMs()); }
  blInit();
  if (bl) { blPoll(); setInterval(blPoll, blPollMs()); console.log(`[blue'Log] poll svakih ${blPollMs() / 1000}s`); }
  s7Init();
  if (s7) { s7Poll(); setInterval(s7Poll, s7PollMs()); }
});
function shutdown() { try { history.save(); } catch (e) {} process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
