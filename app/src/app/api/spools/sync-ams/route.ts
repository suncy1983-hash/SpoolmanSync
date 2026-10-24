import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { SpoolmanClient } from '@/lib/api/spoolman';
import { HomeAssistantClient } from '@/lib/api/homeassistant';
import { applyLocationSync } from '@/lib/spool-location';
import { syncAllAmsTrays } from '@/lib/ams-spool-sync';

/**
 * POST /api/spools/sync-ams
 *
 * Scan every Bambu AMS tray in Home Assistant once: RFID spools that are not in
 * Spoolman yet are created (with the AMS remaining-weight estimate) and
 * assigned to their tray. Trays that already have a spool assigned are left
 * alone. Useful right after installing, since the tray_change automation only
 * fires when a tray actually changes.
 */
export async function POST() {
  try {
    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();
    if (!spoolmanConnection) {
      return NextResponse.json({ error: 'Spoolman not configured' }, { status: 400 });
    }

    const client = new SpoolmanClient(spoolmanConnection.url);
    await client.ensureRequiredFieldsExist();

    let entityIdMap: Map<string, string> | null = null;
    const resolveToUniqueId = async (entityId: string): Promise<string> => {
      if (!entityIdMap) {
        try {
          const haClient = await HomeAssistantClient.fromConnection();
          if (haClient) entityIdMap = await haClient.getEntityIdToUniqueIdMap();
        } catch { /* best-effort */ }
        if (!entityIdMap) entityIdMap = new Map();
      }
      return entityIdMap.get(entityId) || entityId;
    };
    client.setEntityIdResolver(resolveToUniqueId);
    await applyLocationSync(client);

    const summary = await syncAllAmsTrays(client, resolveToUniqueId);
    return NextResponse.json({ success: true, ...summary });
  } catch (error) {
    console.error('AMS sync failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'AMS sync failed' },
      { status: 500 },
    );
  }
}
