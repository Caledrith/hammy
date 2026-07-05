import { readFileSync } from "node:fs";
import { readZipEntry } from "./zip";

const SLICE_INFO_ENTRY = "Metadata/slice_info.config";

export interface SliceInfo {
  estMinutes: number | null;
  estGrams: number | null;
  objectCount: number | null;
  plateCount: number;
}

/**
 * Parse an exported .gcode.3mf for the slicer's own predictions. Bambu writes a
 * Metadata/slice_info.config (XML) with, per plate, a `prediction` (seconds) and
 * a `weight` (grams), plus one <object> element per placed instance. We sum
 * across plates so overflow (multiple plates in one export) rolls up correctly.
 *
 * Parsed with regex rather than a full XML parser to stay dependency-free and
 * tolerant of schema drift between Bambu Studio versions.
 */
export function parseSliceInfoText(xml: string): SliceInfo {
  const numbers = (re: RegExp): number[] => {
    const out: number[] = [];
    for (const m of xml.matchAll(re)) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) out.push(n);
    }
    return out;
  };

  const predictions = numbers(/key="prediction"\s+value="([\d.]+)"/g);
  const weights = numbers(/key="weight"\s+value="([\d.]+)"/g);
  const plateCount = (xml.match(/<plate\b/g) ?? []).length;
  const objectCount = (xml.match(/<object\b/g) ?? []).length;

  const totalSeconds = predictions.reduce((a, b) => a + b, 0);
  const totalGrams = weights.reduce((a, b) => a + b, 0);

  return {
    estMinutes: predictions.length > 0 ? Math.round(totalSeconds / 60) : null,
    estGrams: weights.length > 0 ? Math.round(totalGrams) : null,
    objectCount: objectCount > 0 ? objectCount : null,
    plateCount,
  };
}

/** Read + parse slice_info from an exported 3mf on disk. */
export function readSliceInfo(threeMfPath: string): SliceInfo {
  const buf = readFileSync(threeMfPath);
  const entry = readZipEntry(buf, SLICE_INFO_ENTRY);
  if (!entry) {
    return { estMinutes: null, estGrams: null, objectCount: null, plateCount: 0 };
  }
  return parseSliceInfoText(entry.toString("utf8"));
}
