# Slicer profiles

The worker slices with Bambu Studio using **real profile JSONs exported from the
Bambu Studio GUI**. These can't be hand-written or generated here; they must come
off a machine running the version of Bambu Studio you print with, so they match
its schema exactly.

## Critical: the CLI needs FLATTENED full configs

The Bambu Studio CLI does **not** resolve preset inheritance. A raw exported
preset is only the *delta* from its parent (`"inherits": "..."` + a handful of
keys); feeding that to `--load-settings` makes the CLI silently fall back to
defaults or segfault. Each JSON must be a **complete config with every key and
no `inherits` reference**.

Note: `--datadir` (which would let the CLI resolve inheritance from a data dir)
is an **OrcaSlicer** feature; **Bambu Studio does not support it**. So the JSONs
must be self-contained.

### Producing flattened JSONs

The reliable way is to let the CLI dump the fully-resolved current config with
`--export-settings`:

1. In the GUI, select the exact Printer + Process + Filament presets you print
   with and save/export a **project 3mf** (its presets are embedded).
2. Ask the CLI to flatten them (there is no `--load-3mf` flag; input files are
   positional arguments at the end of the command):
   ```bash
   bambu-studio --export-settings full.json your-project.3mf
   ```
   `full.json` is a complete, inheritance-free dump of machine + process +
   filament settings merged into one object.
3. Split it with the helper script, which classifies each key against Bambu
   Studio's own stock profiles (`resources/profiles/BBL/{machine,process,filament}`)
   and writes the three files to the paths `manifest.json` maps for the given
   model/material:
   ```bash
   npm run split-settings -- full.json --model P1S --material PLA
   ```
   For additional materials, re-export a project with that filament selected
   and only write the filament file:
   ```bash
   npm run split-settings -- full-petg.json --model P1S --material PETG --only filament
   ```
   The script auto-detects the Bambu Studio install location; pass
   `--resources <dir>` if yours is elsewhere.

(Exact `--export-settings` behavior is version-dependent; confirm during the CLI
spike in [`../scripts/worker/README.md`](../scripts/worker/README.md).)

Save the JSONs into the folders below, then point [`manifest.json`](manifest.json)
at the filenames:

```
profiles/
  manifest.json          # preset -> file mapping (edit to match your files)
  machine/               # one per printer model (P1S.json, P2S.json, H2.json)
  process/               # one per model + layer height (P1S-0.2mm.json, ...)
  filament/              # one per material (PLA.json, PETG-CF.json, ...)
```

You only need profiles for the models/materials actually in use. With an empty
`printers` table every plate targets **P1S**, so a P1S machine + process plus one
filament JSON per material you sell is enough to start.

## How the worker uses them

For each plate the server sends a `targetPrinterModel` (e.g. `P1S`), a
`material` (e.g. `PETG-CF`), and a `plateType`. The worker looks up:

- machine = `machineByModel[targetPrinterModel]`
- process = `processByModel[targetPrinterModel]`
- filament = `filamentByMaterial[material]`

and passes them to the CLI as `--load-settings "machine.json;process.json"` and
`--load-filaments filament.json`. If a needed profile isn't mapped or the file is
missing, the worker fails that plate with a clear reason instead of slicing with
the wrong settings.

## Notes

- Keep the material keys in `manifest.json` aligned with the `filament_map`
  materials seeded in [`scripts/seed.ts`](../scripts/seed.ts) (PLA, PLA+, PETG,
  PETG-CF, ABS, ASA).
- The process profile encodes nozzle diameter; if you run multiple nozzle sizes,
  add more process entries and extend the mapping (a future manifest can key
  process by model + nozzle).
- These JSONs are committed so every worker install slices identically.
