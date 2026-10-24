/**
 * Auto-create Spoolman spools from Bambu AMS trays.
 *
 * When a Bambu spool with an RFID tag is loaded and no Spoolman spool carries
 * its serial (tray_uuid), SpoolmanSync can register it on its own: vendor,
 * filament and spool are created from the tray attributes ha-bambulab exposes
 * (name, type, color, tray_weight, remain, nozzle temps), the serial is stored
 * in extra.tag, and the spool is assigned to the tray.
 *
 * The pure helpers at the top have no DB / network access so they can be unit
 * tested; ensureSpoolForTray does the Spoolman writes.
 */

import type { Filament, Spool, SpoolmanClient, Vendor } from '@/lib/api/spoolman';
import { isValidTrayUuid, MATERIAL_DENSITY } from '@/lib/webhook-helpers';

/** Settings key; auto-create is ON unless this is explicitly 'false'. */
export const AUTO_CREATE_SPOOLS_KEY = 'auto_create_spools';

export const BAMBU_VENDOR_NAME = 'Bambu Lab';
/** Empty Bambu reusable spool weight in grams. */
const BAMBU_EMPTY_SPOOL_WEIGHT = 250;
const DEFAULT_FILAMENT_WEIGHT = 1000;
const DEFAULT_DIAMETER = 1.75;

export function isAutoCreateEnabled(settingValue: string | null | undefined): boolean {
  return settingValue !== 'false';
}

/** What we could read off one AMS tray, normalised for Spoolman. */
export interface BambuTrayInfo {
  trayUuid: string;
  /** Filament name without the vendor prefix, e.g. "PLA Basic". */
  filamentName: string;
  material: string;
  /** 6-digit lowercase hex without '#', or undefined if unknown. */
  colorHex?: string;
  /** Comma-separated 6-digit hexes when the tray reports more than one color. */
  multiColorHexes?: string;
  /** Net filament weight of a full spool in grams. */
  trayWeight: number;
  /** Remaining filament in grams, derived from the AMS remain %. */
  remainingWeight: number;
  /** True when remainingWeight comes from a real AMS estimate (remain_enabled). */
  remainFromAms: boolean;
  extruderTemp?: number;
  bedTemp?: number;
  bambuFilamentId?: string;
}

type Attrs = Record<string, unknown>;

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : undefined;
}

/** "#9D432CFF" / "9d432c" → "9d432c"; anything else → undefined. */
export function normalizeColorHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const hex = value.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return undefined;
  return hex.slice(0, 6).toLowerCase();
}

/** "Bambu PLA Basic" → "PLA Basic". Keeps the name as-is if it has no vendor prefix. */
export function stripVendorPrefix(name: string): string {
  const trimmed = name.trim();
  const stripped = trimmed.replace(/^bambu(\s+lab)?\s+/i, '').trim();
  return stripped || trimmed;
}

/** Density for a material, tolerating variants like "PLA-CF" or "PETG HF". */
export function densityForMaterial(material: string): number {
  const upper = material.trim().toUpperCase();
  if (MATERIAL_DENSITY[upper] !== undefined) return MATERIAL_DENSITY[upper];
  const base = upper.split(/[\s\-+/]/)[0];
  if (base && MATERIAL_DENSITY[base] !== undefined) return MATERIAL_DENSITY[base];
  return MATERIAL_DENSITY.PLA;
}

/**
 * Read a ha-bambulab tray's attributes. Returns null when the tray is not a
 * Bambu RFID spool we can register (empty, no/zero serial, or unknown name).
 */
export function parseBambuTray(attrs: Attrs | null | undefined): BambuTrayInfo | null {
  if (!attrs) return null;
  if (attrs.empty === true) return null;

  const trayUuid = typeof attrs.tray_uuid === 'string' ? attrs.tray_uuid.trim() : '';
  if (!isValidTrayUuid(trayUuid)) return null;

  const rawName = typeof attrs.name === 'string' ? attrs.name.trim() : '';
  const lowerName = rawName.toLowerCase();
  if (!rawName || ['empty', 'unknown', 'unavailable', '?'].includes(lowerName)) return null;

  const material = (typeof attrs.type === 'string' ? attrs.type.trim() : '') || 'PLA';

  const cols = Array.isArray(attrs.cols)
    ? (attrs.cols as unknown[]).map(normalizeColorHex).filter((c): c is string => !!c)
    : [];
  const uniqueCols = Array.from(new Set(cols));
  const colorHex = normalizeColorHex(attrs.color) ?? uniqueCols[0];
  const multiColorHexes = uniqueCols.length > 1 ? uniqueCols.join(',') : undefined;

  const reportedWeight = toNumber(attrs.tray_weight);
  const trayWeight = reportedWeight && reportedWeight > 0 ? reportedWeight : DEFAULT_FILAMENT_WEIGHT;

  const remain = toNumber(attrs.remain);
  const remainFromAms = attrs.remain_enabled === true && remain !== undefined && remain >= 0 && remain <= 100;
  const remainingWeight = remainFromAms
    ? Math.round((trayWeight * (remain as number)) / 100)
    : trayWeight;

  const minTemp = toNumber(attrs.nozzle_temp_min);
  const maxTemp = toNumber(attrs.nozzle_temp_max);
  const extruderTemp = minTemp && maxTemp
    ? Math.round((minTemp + maxTemp) / 2)
    : (maxTemp || minTemp || undefined);
  const bedTemp = toNumber(attrs.bed_temp);

  const bambuFilamentId = typeof attrs.filament_id === 'string' && attrs.filament_id.trim()
    ? attrs.filament_id.trim()
    : undefined;

  return {
    trayUuid,
    filamentName: stripVendorPrefix(rawName),
    material,
    colorHex,
    multiColorHexes,
    trayWeight,
    remainingWeight,
    remainFromAms,
    extruderTemp,
    bedTemp: bedTemp && bedTemp > 0 ? bedTemp : undefined,
    bambuFilamentId,
  };
}

export function findBambuVendor(vendors: Vendor[]): Vendor | undefined {
  return vendors.find(v => /^bambu(\s*lab)?$/i.test(v.name.trim()));
}

function normalizeHexList(value: string | null | undefined): string {
  if (!value) return '';
  return value.split(',').map(normalizeColorHex).filter(Boolean).sort().join(',');
}

/**
 * Find an existing Bambu filament matching the tray: same vendor, material,
 * name (case-insensitive) and color. Filaments the user created by hand or
 * imported from SpoolmanDB are reused instead of being duplicated.
 */
export function findMatchingFilament(
  filaments: Filament[],
  vendorId: number,
  info: BambuTrayInfo,
): Filament | undefined {
  const name = info.filamentName.toLowerCase();
  const material = info.material.toLowerCase();

  const candidates = filaments.filter(f =>
    f.vendor?.id === vendorId && (f.material ?? '').toLowerCase() === material,
  );
  const sameColor = (f: Filament) => {
    if (info.multiColorHexes) {
      return normalizeHexList(f.multi_color_hexes) === normalizeHexList(info.multiColorHexes);
    }
    return !!info.colorHex && !f.multi_color_hexes && normalizeColorHex(f.color_hex ?? '') === info.colorHex;
  };

  // Exact name first, then names that contain ours (e.g. SpoolmanDB's
  // "PLA Basic Black" when the tray says "PLA Basic").
  return candidates.find(f => f.name.toLowerCase() === name && sameColor(f))
    ?? candidates.find(f => f.name.toLowerCase().includes(name) && sameColor(f));
}

/** Differences smaller than this are AMS rounding noise and are not written. */
export const WEIGHT_SYNC_MIN_DIFF_G = 1;

export type WeightSyncDecision =
  | { action: 'update'; remainingWeight: number; previous: number }
  | { action: 'skip'; reason: 'no_ams_estimate' | 'different_spool' | 'unchanged' };

/**
 * Decide whether a spool's remaining weight should be overwritten with the
 * AMS estimate of the tray it sits in. Only the same physical spool is updated:
 * a stored serial that differs from the tray's means another spool is loaded.
 */
export function decideWeightSync(
  spool: Pick<Spool, 'remaining_weight' | 'extra'>,
  info: BambuTrayInfo,
  normalize: (v: string | undefined | null) => string,
): WeightSyncDecision {
  if (!info.remainFromAms) return { action: 'skip', reason: 'no_ams_estimate' };
  const storedTag = normalize(spool.extra?.['tag']);
  if (storedTag && storedTag !== normalize(info.trayUuid)) {
    return { action: 'skip', reason: 'different_spool' };
  }
  const previous = Number(spool.remaining_weight) || 0;
  if (Math.abs(previous - info.remainingWeight) < WEIGHT_SYNC_MIN_DIFF_G) {
    return { action: 'skip', reason: 'unchanged' };
  }
  return { action: 'update', remainingWeight: info.remainingWeight, previous };
}

export interface EnsureSpoolResult {
  spool: Spool;
  created: boolean;
  filamentCreated: boolean;
  vendorCreated: boolean;
}

/**
 * Return the Spoolman spool for this tray's RFID serial, creating vendor,
 * filament and spool when none exists. Does not assign it to a tray.
 */
export async function ensureSpoolForTray(
  client: SpoolmanClient,
  info: BambuTrayInfo,
): Promise<EnsureSpoolResult> {
  // Re-check right before writing: another event may have created it meanwhile.
  const existing = await client.findSpoolByTag(info.trayUuid);
  if (existing) {
    return { spool: existing, created: false, filamentCreated: false, vendorCreated: false };
  }

  let vendorCreated = false;
  let vendor = findBambuVendor(await client.getVendors());
  if (!vendor) {
    vendor = await client.createVendor({
      name: BAMBU_VENDOR_NAME,
      empty_spool_weight: BAMBU_EMPTY_SPOOL_WEIGHT,
    });
    vendorCreated = true;
  }

  let filamentCreated = false;
  let filament = findMatchingFilament(await client.getFilaments(), vendor.id, info);
  if (!filament) {
    filament = await client.createFilament({
      name: info.filamentName,
      vendor_id: vendor.id,
      material: info.material,
      density: densityForMaterial(info.material),
      diameter: DEFAULT_DIAMETER,
      weight: info.trayWeight,
      spool_weight: BAMBU_EMPTY_SPOOL_WEIGHT,
      ...(info.multiColorHexes
        ? { multi_color_hexes: info.multiColorHexes, multi_color_direction: 'coaxial' as const }
        : info.colorHex ? { color_hex: info.colorHex } : {}),
      ...(info.extruderTemp ? { settings_extruder_temp: info.extruderTemp } : {}),
      ...(info.bedTemp ? { settings_bed_temp: info.bedTemp } : {}),
      ...(info.bambuFilamentId ? { comment: `Bambu filament_id: ${info.bambuFilamentId}` } : {}),
    });
    filamentCreated = true;
  }

  const spool = await client.createSpool({
    filament_id: filament.id,
    initial_weight: info.trayWeight,
    remaining_weight: info.remainingWeight,
    spool_weight: BAMBU_EMPTY_SPOOL_WEIGHT,
    comment: info.remainFromAms
      ? 'Auto-created by SpoolmanSync from AMS RFID (remaining weight from AMS estimate)'
      : 'Auto-created by SpoolmanSync from AMS RFID',
    extra: { tag: JSON.stringify(info.trayUuid) },
  });

  return { spool, created: true, filamentCreated, vendorCreated };
}
