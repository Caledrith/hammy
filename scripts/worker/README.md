# Slicer worker (shop PC)

Pull-based slicer agent. It runs on the Windows shop PC (the machine with the
STL library, Bambu Studio, and the printers on its LAN), polls the server for
`draft` plates, slices them with the Bambu Studio CLI, and reports real
estimates back. **Only outbound HTTPS is used**, so the PC needs no inbound
ports, VPN, or static IP.

```
claim  -> resolve model paths under MODELS_ROOT -> verify they exist
       -> run Bambu Studio CLI (arrange + slice + export .gcode.3mf)
       -> parse Metadata/slice_info.config for time + grams
       -> complete (or fail, which re-queues the plate's jobs)
```

## Files

| File | Role |
| --- | --- |
| `index.ts` | Poll loop + per-plate orchestration |
| `config.ts` | Env loading (`scripts/worker/.env`, then repo `.env`) |
| `api.ts` | HTTP client for `/api/worker/*` |
| `cli.ts` | Profile resolution + Bambu Studio CLI invocation |
| `sliceinfo.ts` | Parse `slice_info.config` from an exported 3mf |
| `zip.ts` | Dependency-free ZIP reader (a 3mf is a ZIP) |

Slicer profiles live in the repo's [`profiles/`](../../profiles/README.md) folder.

---

## Windows PC setup checklist

1. **Install Git + Node 22 LTS**
   ```powershell
   winget install Git.Git OpenJS.NodeJS.LTS
   ```
2. **Install Bambu Studio.** The GUI install includes the CLI-capable
   `bambu-studio.exe` (default `C:\Program Files\Bambu Studio\bambu-studio.exe`).
   Bambu Connect can stay installed; it is unrelated to the CLI.
3. **Clone the repo and install deps**
   ```powershell
   git clone <repo-url> hammy
   cd hammy
   npm install
   ```
4. **Configure the worker.** Copy the example and fill it in:
   ```powershell
   copy scripts\worker\.env.example scripts\worker\.env
   ```
   - `SERVER_URL` — public URL of the deployed server (no trailing slash)
   - `WORKER_TOKEN` — must equal the server's `WORKER_TOKEN`
   - `MODELS_ROOT` — folder holding the STL tree (e.g. `D:\models`)
   - `BAMBU_CLI_PATH` — e.g. `C:\Program Files\Bambu Studio\bambu-studio.exe`
   - `OUTPUT_DIR` — where `.gcode.3mf` files are written (e.g. `D:\plates-out`)
5. **Export slicer profiles** from the Bambu Studio GUI into `profiles/` and
   update `profiles/manifest.json` — see [`profiles/README.md`](../../profiles/README.md).
6. **Register the model library on the server** (run once, from the server or any
   box with `DATABASE_URL`), feeding it a listing of the STL tree:
   ```powershell
   dir /b /s D:\models > stl-files.txt   # or maintain the existing stl-files.txt
   npm run import-files
   ```
7. **Test run**
   ```powershell
   npm run worker
   ```
   Then compose a plate from the dashboard `/plates` page and watch the log show
   `claimed plate N ... SLICED -> plate-N.gcode.3mf`.
8. **Run it as an always-on service** so it survives reboots. With
   [NSSM](https://nssm.cc/):
   ```powershell
   nssm install hammy-worker "C:\Program Files\nodejs\npm.cmd" "run worker"
   nssm set hammy-worker AppDirectory C:\path\to\hammy
   nssm set hammy-worker AppExit Default Restart
   nssm start hammy-worker
   ```
   (A Task Scheduler "at log on" task with restart-on-failure also works.)

---

## CLI spike (do this FIRST, before trusting the automation)

Bambu Studio's CLI flags and `slice_info.config` schema drift between releases.
Confirm the behavior your installed version has, by hand, against a few real
STLs. `cli.ts` centralizes the flags so this is the only place to adjust.

1. Pick 2-3 real STLs from `MODELS_ROOT` and a set of exported profiles.
2. Run the same command the worker builds (see `buildArgs` in `cli.ts`):
   ```powershell
   & "C:\Program Files\Bambu Studio\bambu-studio.exe" `
     --load-settings "profiles\machine\P1S.json;profiles\process\P1S-0.2mm.json" `
     --load-filaments "profiles\filament\PLA.json" `
     --curr-bed-type "Textured PEI Plate" `
     --arrange 1 --orient 1 --slice 0 `
     --export-3mf "D:\plates-out\spike.gcode.3mf" `
     "D:\models\path\to\a.stl" "D:\models\path\to\a.stl" "D:\models\path\to\b.stl"
   ```
3. **Verify each assumption** the worker relies on:
   - [ ] Repeating a path N times produces N copies on the plate.
   - [ ] More parts than fit on one bed overflow onto additional plates
         (rather than erroring). Note how that shows up so capacity tuning in
         `src/lib/plates/compose.ts` (`MODEL_CAPACITY`) can match reality.
   - [ ] `--load-settings` accepts `machine;process` joined by `;`, and the
         profile JSON format matches your exports. Adjust flag names in
         `buildArgs` if your version differs.
   - [ ] `--curr-bed-type` accepts the strings in `bedTypeFor` (`cli.ts`).
   - [ ] The exported 3mf contains `Metadata/slice_info.config` with
         `key="prediction"` (seconds) and `key="weight"` (grams). Inspect with:
         ```powershell
         npx tsx -e "import('./scripts/worker/sliceinfo.js')" # or unzip and read
         ```
4. Fold any deltas back into `cli.ts` (flags / bed types) and
   `MODEL_CAPACITY` (`src/lib/plates/compose.ts`), then re-run `npm run worker`.
