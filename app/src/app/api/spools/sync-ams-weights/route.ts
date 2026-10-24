import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { SpoolmanClient } from '@/lib/api/spoolman';
import { HomeAssistantClient } from '@/lib/api/homeassistant';
import { syncWeightsFromAms } from '@/lib/ams-spool-sync';

/**
 * POST /api/spools/sync-ams-weights   body: { trayId?: string }
 *
 * Manually overwrite the remaining weight of spools in the AMS with the AMS
 * estimate (tray_weight × remain %). Without trayId every tray is synced; with
 * it only that tray's spool. Per-print deductions stay the normal mechanism;
 * this is for correcting spools whose stored weight is off (e.g. partly used
 * spools registered as full).
 */
export async function POST(request: NextRequest) {
  try {
    let trayId: string | undefined;
    try {
      const body = await request.json();
      if (typeof body?.trayId === 'string' && body.trayId.trim()) trayId = body.trayId.trim();
    } catch { /* empty body = all trays */ }

    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();
    if (!spoolmanConnection) {
      return NextResponse.json({ error: 'Spoolman not configured' }, { status: 400 });
    }
    const client = new SpoolmanClient(spoolmanConnection.url);

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

    const summary = await syncWeightsFromAms(client, resolveToUniqueId, trayId);
    return NextResponse.json({ success: true, ...summary });
  } catch (error) {
    console.error('AMS weight sync failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'AMS weight sync failed' },
      { status: 500 },
    );
  }
}
