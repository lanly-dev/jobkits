# jobkits

A desktop app that runs **self-hosted services as desktop apps**, via [Podman](https://podman.io).
Pick a kit, press Start — jobkits clones the service's upstream source at a pinned
commit, generates its secrets and ports, brings its stack up with `podman compose`,
and loads its web UI in the app window once it's healthy.

**Kit #1: [freehire](https://github.com/strelov1/freehire)** — the open-source job
search engine (3.3M+ postings straight from company ATS career pages, CV builder,
fit analysis, application tracking). Later kits are drop-in folders; see
*Adding a kit* below.

Version 0.2.0 — adds a VirtualBox-style GUI for the Podman machine: a first-run
setup wizard and a machine settings panel, so no terminal is needed anywhere.

## Prerequisites

- **Podman** — jobkits can install it for you from the app when it's missing
  (see the "Install Podman automatically" button), or install manually from
  https://podman.io/docs/installation
  - **Windows/macOS:** that's the only manual step. Podman runs containers in a
    small Linux VM — the "machine" — and jobkits creates it for you with the
    built-in setup wizard (see *Podman machine GUI* below). Starting a kit never
    auto-creates a machine; creation is always wizard-driven, because it
    downloads a VM image and takes a few minutes.
  - **Linux:** no machine needed; a system podman is enough.
  - Compose support needs Podman ≥ 4.7 (`podman compose`) or a `podman-compose`
    binary on PATH. jobkits prefers `podman compose`, because freehire's compose
    file relies on `depends_on: service_healthy` / `service_completed_successfully`.
- **git** on PATH (first run clones the kit's upstream repo).
- Node 20+ / npm only for developing jobkits itself.

Without Podman the app still opens and explains what's missing — it just can't
start kits.

## How it works

For the selected kit, Start does:

1. **Source** — `git clone <repo>` into the app's data dir
   (`userData/kits/<id>/src`) and check out `pinnedCommit` from `kit.json`.
   jobkits does **not** bundle upstream source; the kit's compose file is run
   from that checkout because its `app`/`web` services build from source.
2. **Env** — write `.env` into the checkout: secrets (`JWT_SECRET`,
   `MEILI_MASTER_KEY`, …) generated once with `crypto` (≥48 chars) and persisted,
   plus host ports probed free on first run (defaults 8080/8090/5432/7700/9000 —
   a taken default is skipped to the next free port). State lives in
   `userData/jobkits-state.json`; secrets and ports never change afterwards.
   Optional LLM settings from the UI (`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`)
   are passed through for freehire's CV / fit-analysis features.
3. **Machine** — on Windows/macOS, `podman machine start` if stopped. If no
   machine exists, Start stops with guidance pointing at the setup wizard —
   it never runs `machine init` itself.
4. **Up** — `podman compose up -d --build`, output streamed to the log pane.
5. **Health** — poll `http://127.0.0.1:<healthPort><healthPath>` (freehire:
   `:8080/health`) for up to ~5 minutes, then load
   `http://127.0.0.1:<webPort>` (freehire web UI: `:8090`) in the app window.

Stop runs `compose down`. **Wipe data** runs `compose down -v` (deletes the
kit's database/search/storage volumes; the source checkout and jobkits state
are kept), after a confirmation dialog.

## Podman machine GUI (Windows/macOS)

- **Setup wizard** — when Podman is installed but no machine exists, the app
  shows a "Set up Podman machine" panel instead of terminal instructions:
  presets (Light 2 CPU / 4 GiB / 30 GiB · Recommended 4 / 8 / 50 · Power
  8 / 16 / 100 — clamped to what your PC actually has), sliders for CPUs,
  memory and disk, a rootful toggle (off = rootless, the safer default) and a
  "start after creating" option. **Create machine** runs
  `podman machine init --cpus … --memory … --disk-size …` with the output
  streamed into the panel's log.
- **Machine settings** — when a machine exists, the panel shows its current
  CPUs / memory / disk / root mode (read back via `podman machine inspect`)
  and lets you edit them. Disk size **can only grow** — Podman cannot shrink
  a machine disk — so the disk slider's minimum is the current size. Settings
  can only change while the machine is stopped: if it's running, Apply asks
  first, then jobkits stops it, runs `podman machine set` with only the
  changed values, and (by default) starts it again.

## Kits

A kit is a folder `kits/<id>/` with two files:

- `kit.json` — the manifest:
  ```jsonc
  {
    "id": "freehire",                    // must match the folder name
    "name": "freehire",
    "description": "…",
    "repo": "https://github.com/strelov1/freehire",
    "pinnedCommit": "<full 40-char sha>",
    "composeFile": "compose.yml",        // reference copy kept in this folder
    "portEnv": { "app": "HIRE_HOST_PORT", "web": "WEB_HOST_PORT", … },
    "defaultPorts": { "HIRE_HOST_PORT": 8080, … },
    "webPort": 8090, "webPortEnv": "WEB_HOST_PORT",
    "healthPath": "/health", "healthPort": 8080, "healthPortEnv": "HIRE_HOST_PORT",
    "requiredSecrets": ["JWT_SECRET", …], // generated once by jobkits
    "optionalEnv": ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"],
    "services": ["app", "web", "db", …]   // for the status dots
  }
  ```
- `compose.yml` — a reference copy of the upstream compose file at the pinned
  commit, with a header noting the pin. The executed compose file is the one in
  the checked-out source tree; this copy records exactly what will run.

### Adding kit #2

1. Create `kits/<new-id>/kit.json` + copy the service's compose file in as
   `compose.yml` with the pin header.
2. The service must be self-hostable from a git repo whose compose stack comes
   up with `podman compose up -d --build` and exposes an HTTP health endpoint.
3. Restart jobkits — the kit appears in the list automatically. No code changes.

## freehire pin

- Repo: `strelov1/freehire`, pinned at **`def9d6882fc78c1d15b5a4c9f11d502d3c3bb19c`**
- Stack (7 services): `app` (Go API, :8080, built from source), `web` (SvelteKit
  frontend behind nginx, :8090, built from source), `db` (`pgvector/pgvector:pg18`),
  `meilisearch` (v1.49.0), `redis` (8-alpine), `s3` (`adobe/s3mock`), `s3-init`.
- Note: the pinned upstream compose hardcodes the internal Postgres credentials
  (`hire`/`hire`) and database URL. jobkits still generates and persists a
  `POSTGRES_PASSWORD` in `.env`/state, ready for a future compose that templates
  it — the pinned one doesn't consume it.

## Develop

```bash
npm install
npm start        # electron .
npm test         # node test/jobkits.test.js (no podman required)
npm run pack     # electron-packager into out/
JOBKITS_SMOKE=1 npx electron . --no-sandbox   # headless smoke: opens, reports, quits
```
