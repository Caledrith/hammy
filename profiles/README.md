# Slicer profiles

The worker slices with Bambu Studio using **real profile JSONs exported from the
Bambu Studio GUI**. These can't be hand-written or generated here; they must come
off a machine running the version of Bambu Studio you print with, so they match
its schema exactly.

## What to export

In Bambu Studio, for each preset you use, open the preset dropdown (Printer /
Process / Filament) and choose **Export → Export preset** (or export the config
bundle and split it). Save the JSONs into the folders below, then make sure
[`manifest.json`](manifest.json) points at the filenames you saved.

```
profiles/
  manifest.json          # preset -> file mapping (edit to match your files)
  machine/               # one per printer model (P1S.json, P2S.json, H2.json)
  process/               # one per model + layer height (P1S-0.2mm.json, ...)
  filament/              # one per material (PLA.json, PETG-CF.json, ...)
```

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
