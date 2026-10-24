/**
 * Glue between Home Assistant tray state and auto-created Spoolman spools.
 * Used by the tray_change webhook and by the manual "Sync AMS spools" action.
 */

import type { Spool, SpoolmanClient } from '@/lib/api/spoolman';
import { HomeAssistantClient, type HAState } from '@/lib/api/homeassistant';
import { createActivityLog } from '@/lib/activity-log';
import { spoolEvents, SPOOL_UPDATED, SpoolUpdateEvent } from '@/lib/events';
import { decideWeightSync, ensureSpoolForTray, parseBambuTray } from '@/lib/auto-create-spool';
import { normalizeTag } from '@/lib/api/spoolman';

export interface AutoCreateOutcome {
  spool: Spool;
  created: boolean;
}

/**
 * Read the tray's live attributes from HA, find or create the Spoolman spool
 * for its RFID serial and assign it to the tray. Returns null when the tray is
 * not an RFID Bambu spool (or HA no longer reports the expected serial).
 */
export async function autoCreateAndAssign(
  client: SpoolmanClient,
  trayEntityId: string,
  trayUniqueId: string,
  expectedTrayUuid?: string,
  attributes?: Record<string, unknown>,
): Promise<AutoCreateOutcome | null> {
  let attrs = attributes;
  if (!attrs) {
    const haClient = await HomeAssistantClient.fromConnection();
    if (!haClient) return null;
    const state = await haClient.getState(trayEntityId);
    attrs = (state?.attributes ?? {}) as Record<string, unknown>;
  }

  const info = parseBambuTray(attrs);
  if (!info) return null;
  // The tray may have changed between the event and our read; never register
  // a different spool than the one the event was about.
  if (expectedTrayUuid && normalizeTag(expectedTrayUuid) !== normalizeTag(info.trayUuid)) {
    return null;
  }

  const result = await ensureSpoolForTray(client, info);
  await client.assignSpoolToTray(result.spool.id, trayUniqueId);

  const spoolName = result.spool.filament?.name ?? info.filamentName;
  const updateEvent: SpoolUpdateEvent = {
    type: 'assign',
    spoolId: result.spool.id,
    spoolName,
    trayId: trayEntityId,
    timestamp: Date.now(),
  };
  spoolEvents.emit(SPOOL_UPDATED, updateEvent);

  await createActivityLog({
    type: 'spool_change',
    message: result.created
      ? `Auto-created spool #${result.spool.id} (${spoolName}, ${info.remainingWeight}g left) from AMS RFID and assigned it to ${trayEntityId}`
      : `Auto-assigned spool #${result.spool.id} to ${trayEntityId} (matched by spool serial)`,
    details: {
      spoolId: result.spool.id,
      trayId: trayEntityId,
      matchedBy: result.created ? 'auto_created' : 'spool_serial',
      trayUuid: info.trayUuid,
      ...(result.created && {
        remainingWeight: info.remainingWeight,
        remainFromAms: info.remainFromAms,
        filamentCreated: result.filamentCreated,
        vendorCreated: result.vendorCreated,
      }),
    },
  });

  return { spool: result.spool, created: result.created };
}

export interface SyncSummary {
  scanned: number;
  created: number;
  assigned: number;
  alreadyAssigned: number;
  skipped: number;
  errors: { trayId: string; error: string }[];
}

/** Entity ids that mirror another tray rather than being a slot of their own. */
function isMirrorEntity(entityId: string): boolean {
  return /_active_tray$/.test(entityId);
}

/** Current HA state of every Bambu AMS / external tray (not the mirror sensors). */
async function listBambuTrays(): Promise<HAState[]> {
  const haClient = await HomeAssistantClient.fromConnection();
  if (!haClient) throw new Error('Home Assistant is not connected');

  const registry = await haClient.getTrayEntityRegistry();
  const bambuEntityIds = new Set(
    Array.from(registry.entries())
      .filter(([, v]) => v.platform === 'bambu_lab')
      .map(([entityId]) => entityId),
  );

  const states = await haClient.getStates();
  return states.filter(s =>
    bambuEntityIds.has(s.entity_id)
    && !isMirrorEntity(s.entity_id)
    && s.attributes && 'tray_uuid' in s.attributes,
  );
}

export interface WeightSyncSummary {
  scanned: number;
  updated: { spoolId: number; trayId: string; from: number; to: number }[];
  unchanged: number;
  skipped: number;
  errors: { trayId: string; error: string }[];
}

/**
 * Overwrite the remaining weight of spools sitting in the AMS with the AMS
 * estimate (tray_weight × remain %). Only the same physical spool is touched
 * (see decideWeightSync). Pass trayEntityId to update a single tray.
 */
export async function syncWeightsFromAms(
  client: SpoolmanClient,
  resolveToUniqueId: (entityId: string) => Promise<string>,
  trayEntityId?: string,
): Promise<WeightSyncSummary> {
  const summary: WeightSyncSummary = { scanned: 0, updated: [], unchanged: 0, skipped: 0, errors: [] };

  let trays = await listBambuTrays();
  if (trayEntityId) {
    trays = trays.filter(t => t.entity_id === trayEntityId);
    if (trays.length === 0) throw new Error(`Tray ${trayEntityId} not found`);
  }

  const spools = await client.getSpools();

  for (const tray of trays) {
    summary.scanned++;
    try {
      const info = parseBambuTray(tray.attributes as Record<string, unknown>);
      if (!info) { summary.skipped++; continue; }

      const uniqueId = await resolveToUniqueId(tray.entity_id);
      const spool = spools.find(s =>
        s.extra?.['active_tray'] === JSON.stringify(uniqueId)
        || s.extra?.['active_tray'] === JSON.stringify(tray.entity_id),
      ) ?? spools.find(s => normalizeTag(s.extra?.['tag']) === normalizeTag(info.trayUuid));
      if (!spool) { summary.skipped++; continue; }

      const decision = decideWeightSync(spool, info, normalizeTag);
      if (decision.action === 'skip') {
        if (decision.reason === 'unchanged') summary.unchanged++;
        else summary.skipped++;
        continue;
      }

      await client.updateSpool(spool.id, { remaining_weight: decision.remainingWeight });
      summary.updated.push({ spoolId: spool.id, trayId: tray.entity_id, from: decision.previous, to: decision.remainingWeight });

      const weightEvent: SpoolUpdateEvent = {
        type: 'weight_sync',
        spoolId: spool.id,
        spoolName: spool.filament?.name ?? info.filamentName,
        newWeight: decision.remainingWeight,
        trayId: tray.entity_id,
        timestamp: Date.now(),
      };
      spoolEvents.emit(SPOOL_UPDATED, weightEvent);
    } catch (err) {
      summary.errors.push({ trayId: tray.entity_id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await createActivityLog({
    type: 'ams_weight_sync',
    message: trayEntityId
      ? (summary.updated.length
        ? `Weight synced from AMS for ${trayEntityId}: spool #${summary.updated[0].spoolId} ${Math.round(summary.updated[0].from)}g → ${summary.updated[0].to}g`
        : `Weight sync from AMS for ${trayEntityId}: nothing to update`)
      : `Weight sync from AMS: ${summary.updated.length} updated, ${summary.unchanged} unchanged, ${summary.skipped} skipped, ${summary.errors.length} errors`,
    details: { ...summary },
  });

  return summary;
}

/**
 * Walk every Bambu tray HA knows about and make sure each loaded RFID spool
 * exists in Spoolman and is assigned to its tray. Trays that already have a
 * spool assigned are left alone.
 */
export async function syncAllAmsTrays(
  client: SpoolmanClient,
  resolveToUniqueId: (entityId: string) => Promise<string>,
): Promise<SyncSummary> {
  const summary: SyncSummary = { scanned: 0, created: 0, assigned: 0, alreadyAssigned: 0, skipped: 0, errors: [] };

  const trays = await listBambuTrays();
  const spools = await client.getSpools();

  for (const tray of trays) {
    summary.scanned++;
    try {
      const uniqueId = await resolveToUniqueId(tray.entity_id);
      const assigned = spools.find(s =>
        s.extra?.['active_tray'] === JSON.stringify(uniqueId)
        || s.extra?.['active_tray'] === JSON.stringify(tray.entity_id),
      );
      const attrs = tray.attributes as Record<string, unknown>;
      const info = parseBambuTray(attrs);

      if (assigned) {
        // Whatever is assigned (by hand or earlier sync) is left untouched.
        summary.alreadyAssigned++;
        continue;
      }
      if (!info) {
        summary.skipped++;
        continue;
      }

      const outcome = await autoCreateAndAssign(client, tray.entity_id, uniqueId, undefined, attrs);
      if (!outcome) {
        summary.skipped++;
      } else if (outcome.created) {
        summary.created++;
      } else {
        summary.assigned++;
      }
    } catch (err) {
      summary.errors.push({ trayId: tray.entity_id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await createActivityLog({
    type: 'ams_sync',
    message: `AMS sync: ${summary.created} created, ${summary.assigned} assigned, ${summary.alreadyAssigned} already assigned, ${summary.skipped} skipped (no RFID), ${summary.errors.length} errors`,
    details: { ...summary },
  });

  return summary;
}
