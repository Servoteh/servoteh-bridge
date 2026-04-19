# Servoteh Bridge

Read-only Node.js servis koji sinhronizuje BigTehn (SQL Server `QBigTehn`) → Supabase cache. Deploy: Windows Service na firma serveru gde je BigTehn SQL.

**Faza 1B (trenutno):** Sinhronizuje 5 kataloga svako jutro u 06:00 — sektori, mašine, komitenti, radnici, lokacije delova. Ne menja ni jedan red u BigTehn-u.

Pun arhitekturni opis: vidi [`BIGTEHN_DATA_MAP.md`](https://github.com/Servoteh/servoteh-plan-montaze/blob/main/docs/BIGTEHN_DATA_MAP.md) (u `servoteh-plan-montaze` repo-u).

---

## Šta radi

| Job | SQL Server izvor | Supabase cilj | Frekvencija | Polja |
|---|---|---|---|---|
| `departments` | `tRadneJedinice` | `bigtehn_departments_cache` | dnevno 06:00 | id, name |
| `machines`    | `tOperacije`     | `bigtehn_machines_cache`    | dnevno 06:00 | rj_code, name, department_id, no_procedure, … |
| `customers`   | `Komitenti`      | `bigtehn_customers_cache`   | dnevno 06:00 | id, name, short_name, city, tax_id |
| `workers`     | `tRadnici`       | `bigtehn_workers_cache`     | dnevno 06:00 | id, full_name, short_name, department_id, card_id, is_active **(BEZ Password kolona — vidi sekciju 6.6 BIGTEHN_DATA_MAP.md)** |
| `locations`   | `tLokacijeDelova`| `bigtehn_locations_cache`   | dnevno 06:00 | id, code, name, department_id, is_active **(pretpostavljena shema — vidi napomenu ispod)** |

Svaki run loguje u `bridge_sync_log` tabelu (i u composite `catalogs_daily` red).

> **Napomena o `locations`:** `BIGTEHN_DATA_MAP.md` (sekcija 5) ne specificira tačne kolone tabele `tLokacijeDelova` — pretpostavljene su (`IDLokacije`, `SifraLokacije`, `NazivLokacije`, `IDRadneJedinice`, `Aktivan`). Ako prvi run padne sa `Invalid column name 'X'`, pokreni:
> ```powershell
> npm run discover:columns -- tLokacijeDelova
> ```
> i ažuriraj `src/jobs/syncLocations.js` (SQL na vrhu fajla) prema stvarnim imenima kolona. Locations job je u composite-u tretiran kao "best-effort" — ako padne, ostala 4 kataloga su već sinhronizovana.

---

## Preduslovi

### Na Bridge serveru (Windows)

- **Node.js 20 ili 22** (`node --version`)
- Mrežni pristup do `Vasa-SQL:5765`
- Mrežni pristup do `*.supabase.co` (HTTPS 443)
- **SQL Server čitalac** — preporuka: kreirati zaseban login `bridge_reader` sa SELECT pravima na: `tRadneJedinice`, `tOperacije`, `Komitenti`, `tRadnici`, `tLokacijeDelova`. Faza 1C dodaje još tabela.
- Za servis instalaciju: **PowerShell pokrenut kao Administrator**

### U Supabase-u (PRE prvog run-a Bridge servisa)

Sledeće tabele MORAJU postojati. Run u Supabase SQL Editor-u:

```sql
-- 1) bridge_sync_log (audit trail)
CREATE TABLE IF NOT EXISTS bridge_sync_log (
  id BIGSERIAL PRIMARY KEY,
  sync_job TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  rows_inserted INT DEFAULT 0,
  rows_updated INT DEFAULT 0,
  rows_deleted INT DEFAULT 0,
  error_message TEXT,
  duration_ms INT
);
CREATE INDEX IF NOT EXISTS idx_sync_log_job ON bridge_sync_log(sync_job, started_at DESC);

-- 2) bigtehn_departments_cache
CREATE TABLE IF NOT EXISTS bigtehn_departments_cache (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3) bigtehn_machines_cache
CREATE TABLE IF NOT EXISTS bigtehn_machines_cache (
  rj_code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  department_id TEXT REFERENCES bigtehn_departments_cache(id),
  operation_id INT,
  note TEXT,
  no_procedure BOOLEAN DEFAULT FALSE,
  significant_for_completion BOOLEAN DEFAULT FALSE,
  uses_priority BOOLEAN DEFAULT FALSE,
  skippable BOOLEAN DEFAULT FALSE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bigtehn_machines_dept ON bigtehn_machines_cache(department_id);

-- 4) bigtehn_customers_cache
CREATE TABLE IF NOT EXISTS bigtehn_customers_cache (
  id INT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  city TEXT,
  tax_id TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5) bigtehn_workers_cache
CREATE TABLE IF NOT EXISTS bigtehn_workers_cache (
  id INT PRIMARY KEY,
  full_name TEXT NOT NULL,
  short_name TEXT,
  department_id TEXT REFERENCES bigtehn_departments_cache(id),
  card_id TEXT,
  worker_type_id INT,
  is_active BOOLEAN DEFAULT TRUE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6) bigtehn_locations_cache (pretpostavljena shema — vidi napomenu o discover:columns)
CREATE TABLE IF NOT EXISTS bigtehn_locations_cache (
  id INT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT,
  department_id TEXT REFERENCES bigtehn_departments_cache(id),
  is_active BOOLEAN DEFAULT TRUE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bigtehn_locations_dept ON bigtehn_locations_cache(department_id);

-- 7) RLS — Bridge koristi SERVICE_ROLE key (bypass RLS).
--    Za read iz aplikacije, dodati read-only policy:
ALTER TABLE bigtehn_departments_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE bigtehn_machines_cache    ENABLE ROW LEVEL SECURITY;
ALTER TABLE bigtehn_customers_cache   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bigtehn_workers_cache     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bigtehn_locations_cache   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridge_sync_log           ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read" ON bigtehn_departments_cache FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON bigtehn_machines_cache    FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON bigtehn_customers_cache   FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON bigtehn_workers_cache     FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON bigtehn_locations_cache   FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON bridge_sync_log           FOR SELECT TO authenticated USING (true);
```

Ovaj SQL će kasnije biti deo formalne migracije u `servoteh-plan-montaze` repo-u (Faza 1C-1D), za sada ručno run-ovati u Supabase SQL Editor-u.

---

## Lokalni development (macOS / Windows / Linux)

```bash
git clone https://github.com/Servoteh/servoteh-bridge.git
cd servoteh-bridge

cp .env.example .env
# popuni .env sa stvarnim vrednostima

npm install

# 1) test konekcije
npm run test:connection

# 2) ručno pokrenuti pojedinačni job
npm run sync:departments
npm run sync:machines
npm run sync:customers
npm run sync:workers
npm run sync:locations

# 3) ručno pokrenuti svih 5 odjednom
npm run sync:catalogs

# (debug) — otkrij stvarne kolone neke BigTehn tabele:
npm run discover:columns -- tLokacijeDelova
npm run discover:columns -- tRN

# 4) idle režim sa scheduler-om (čeka 06:00)
npm start
```

`LOG_PRETTY=true` u `.env` daje obojen output u terminalu.

---

## Production deployment (Windows Service)

> Pretpostavlja se Windows Server (ili Windows 10/11 Pro) gde je BigTehn SQL Server. Bridge mora biti na istoj LAN-u (ili mašini).

### 1. Pripremi mašinu

```powershell
# Provera Node-a (treba 20+)
node --version

# Ako Node nije instaliran:
# https://nodejs.org/en/download/  (LTS — 20 ili 22)
```

### 2. Klon + install + .env

```powershell
cd C:\Servoteh
git clone https://github.com/Servoteh/servoteh-bridge.git
cd servoteh-bridge
copy .env.example .env
notepad .env
# Popuni: BIGTEHN_SQL_*, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
npm install --omit=dev
```

### 3. Test konekcije pre instalacije servisa

```powershell
npm run test:connection
# Treba videti dva ✓ reda. Ako padne, NE INSTALIRATI servis.
```

### 4. Test jednog joba

```powershell
npm run sync:departments
# Provera u Supabase Table Editor: bigtehn_departments_cache treba da ima redove.
```

### 5. Instalacija kao Windows Service

**WAŽNO: PowerShell mora biti pokrenut kao Administrator.**

```powershell
npm run service:install
```

Servis se zove `Servoteh Bridge`, auto-startuje na boot. Status: `services.msc`.

### 6. Provera da radi

```powershell
# Logovi
Get-Content .\logs\bridge-$(Get-Date -Format yyyy-MM-dd).log -Tail 50 -Wait

# Ručni run dok je servis aktivan (servis to neće blokirati — koristi isti folder ali drugi proces)
npm run sync:catalogs
```

### 7. Update koda (kad Faza 1C dođe)

```powershell
# Stop servisa
Stop-Service "Servoteh Bridge"

cd C:\Servoteh\servoteh-bridge
git pull
npm install --omit=dev

# Start servisa
Start-Service "Servoteh Bridge"
```

### 8. Uninstall

```powershell
npm run service:uninstall
```

---

## Troubleshooting

### `ConnectionError: Failed to connect to Vasa-SQL:5765`
- Proveri sa Bridge servera: `Test-NetConnection Vasa-SQL -Port 5765`
- Proveri firewall (i na Bridge serveru i na SQL serveru)
- Da li SQL Server ima TCP/IP enabled? (SQL Server Configuration Manager → Protocols → TCP/IP → Enabled)
- Da li `bridge_reader` login ima pristup do `QBigTehn` baze?

### `[supabase] upsert ... failed: relation "bigtehn_..._cache" does not exist`
- Supabase tabele nisu kreirane. Vidi sekciju "Preduslovi → U Supabase-u" iznad.

### `RequestError: Invalid column name 'X'.` (najčešće za locations)
- Pretpostavljena shema u `syncLocations.js` (ili drugom job-u) ne odgovara stvarnoj BigTehn tabeli. Pokreni:
  ```powershell
  npm run discover:columns -- tLokacijeDelova
  ```
- Output ti pokazuje sve kolone + sample TOP 5 redova. Ažuriraj SQL na vrhu odgovarajućeg `src/jobs/sync*.js` fajla, a po potrebi i mapiranje u `mapRow()`. Ako se poklope nazivi → ažuriraj i Supabase shemu (`bigtehn_locations_cache`).

### `[supabase] ... permission denied`
- Bridge koristi `SUPABASE_SERVICE_ROLE_KEY` (bypassuje RLS). Ako vidiš permission denied, koristi `SERVICE_ROLE` key, ne `ANON` key. Provera: `dashboard.supabase.com → Project Settings → API → Service role key` (NE Anon public).

### Servis se ne startuje (Event Viewer pokazuje grešku)
- Logovi: `Event Viewer → Windows Logs → Application` (filter source = "Servoteh Bridge")
- Najčešće: `.env` fajl nedostupan. node-windows servis NE čita `.env` automatski sa workingDirectory u svim slučajevima — alternativa je staviti env vars u **System Environment Variables** (`Edit the system environment variables` → Environment Variables → System variables).

### Logovi previše rastu
- Trenutna verzija pravi 1 fajl po danu (`bridge-YYYY-MM-DD.log`). Stari fajlovi se ne brišu automatski.
- Preporuka: PowerShell scheduled task koji briše logove starije od 30 dana:
  ```powershell
  Get-ChildItem .\logs\bridge-*.log | Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) | Remove-Item
  ```

---

## Sigurnosna napomena

- `.env` je u `.gitignore` — **nikad ga ne commit-uj**.
- `SUPABASE_SERVICE_ROLE_KEY` daje pun pristup bazi (bypass RLS). Drži ga samo na serveru gde Bridge radi.
- `tRadnici.Password` i `PasswordRadnika` su **plaintext** u BigTehn-u. Bridge ih EKSPLICITNO ne čita (vidi `src/jobs/syncWorkers.js` SQL — kolone su izostavljene).
- Preporuka: SQL Server login `bridge_reader` neka ima samo `SELECT` privilegije na ograničen skup tabela (ne `db_owner`, ne `sysadmin`).

---

## Sledeće faze (van scope-a 1B)

- **1C** — sync `Predmeti`, `tRN`, `tStavkeRN`, `tTehPostupak` (svakih 15 min, delta)
- **1D** — overlays + upload crteža u Supabase
- **1E** — write-back (lansiran/saglasan/tehpostupak/StatusRN)

Plan: `BIGTEHN_DATA_MAP.md`, sekcija 8.
