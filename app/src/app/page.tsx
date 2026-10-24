'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { Nav } from '@/components/nav';
import { PrinterCard } from '@/components/dashboard/printer-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { toast } from 'sonner';
import type { HAPrinter } from '@/lib/api/homeassistant';
import type { Spool } from '@/lib/api/spoolman';
import type { ActiveAlert } from '@/lib/alerts';
import Link from 'next/link';

interface PrinterWithSpools extends HAPrinter {
  ams_units: Array<{
    entity_id: string;
    name: string;
    ams_number: number;
    trays: Array<{
      entity_id: string;
      tray_number: number;
      name?: string; // Filament name from printer, "Empty" if no filament loaded
      material?: string;
      color?: string;
      assigned_spool?: Spool;
      [key: string]: unknown;
    }>;
  }>;
  external_spools: Array<{
    entity_id: string;
    tray_number: number;
    is_external?: boolean;
    name?: string;
    assigned_spool?: Spool;
    [key: string]: unknown;
  }>;
}

interface Settings {
  homeassistant: { url: string; connected: boolean } | null;
  spoolman: { url: string; connected: boolean } | null;
  showSpoolLocation?: boolean;
}

export default function Dashboard() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [printers, setPrinters] = useState<PrinterWithSpools[]>([]);
  const [spools, setSpools] = useState<Spool[]>([]);
  const [lowFilamentAlerts, setLowFilamentAlerts] = useState<ActiveAlert[]>([]);
  const [automationsStale, setAutomationsStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [amsAction, setAmsAction] = useState<'create' | 'weights' | null>(null);

  // Track trays that have filament loaded but no spool assigned
  // Returns list with tray label and AMS-reported filament info
  const unassignedTrays = useMemo(() => {
    const trays: { key: string; label: string; name?: string; material?: string; color?: string }[] = [];
    for (const printer of printers) {
      for (const ams of printer.ams_units) {
        for (const tray of ams.trays) {
          // Check if tray has filament (name is not empty/Empty)
          const trayName = tray.name?.toLowerCase().trim() || '';
          const hasFilament = trayName && trayName !== 'empty';

          // Only count if filament is loaded but no spool assigned
          if (hasFilament && !tray.assigned_spool) {
            // Format: "PrinterName > AMS 1 > Tray 3" for clarity across multiple printers/AMS units
            const printerPrefix = printers.length > 1 ? `${printer.name} > ` : '';
            const amsPrefix = printer.ams_units.length > 1 ? `${ams.name} > ` : '';
            trays.push({
              // Stable unique key: the tray entity_id, falling back to a
              // printer+ams+tray composite if it's somehow missing.
              key: tray.entity_id || `${printer.entity_id}:${ams.entity_id}:${tray.tray_number}`,
              label: `${printerPrefix}${amsPrefix}${tray.tray_number}. tálca`,
              name: tray.name,
              material: tray.material,
              color: tray.color,
            });
          }
        }
      }
      // Don't count external spool as "unassigned" by default since many don't use it
    }
    return trays;
  }, [printers]);

  const fetchData = useCallback(async () => {
    try {
      // Fetch settings first
      const settingsRes = await fetch('/api/settings');
      const settingsData = await settingsRes.json();
      setSettings(settingsData);

      // Only fetch printers and spools if both services are configured
      if (settingsData.homeassistant && settingsData.spoolman) {
        const [printersRes, spoolsRes, alertsRes] = await Promise.all([
          fetch('/api/printers'),
          fetch('/api/spools'),
          fetch('/api/alerts'),
        ]);

        if (printersRes.ok) {
          const printersData = await printersRes.json();
          setPrinters(printersData.printers || []);
          setAutomationsStale(printersData.automationsStale || false);
        }

        if (spoolsRes.ok) {
          const spoolsData = await spoolsRes.json();
          setSpools(spoolsData.spools || []);
        }

        if (alertsRes.ok) {
          const alertsData = await alertsRes.json();
          setLowFilamentAlerts(alertsData.alerts || []);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nem sikerült betölteni az adatokat');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Real-time updates: try SSE first, fall back to polling if SSE doesn't work
  // (HA's ingress proxy doesn't support SSE streaming)
  useEffect(() => {
    if (!settings?.homeassistant || !settings?.spoolman) {
      return;
    }

    let eventSource: EventSource | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let sseConnected = false;
    let pollInterval: NodeJS.Timeout | null = null;
    let sseCheckTimeout: NodeJS.Timeout | null = null;

    const startPolling = () => {
      if (pollInterval) return; // Already polling
      console.log('SSE unavailable, falling back to polling every 2s');
      pollInterval = setInterval(() => {
        fetchData();
      }, 2000);
    };

    const handleSSEMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'connected') {
          sseConnected = true;
          // SSE works — cancel the fallback check
          if (sseCheckTimeout) {
            clearTimeout(sseCheckTimeout);
            sseCheckTimeout = null;
          }
          return;
        }

        if (data.type === 'heartbeat') return;

        if (data.type === 'usage') {
          toast.info(`Felhasznált filament: ${Math.round(data.deducted * 100) / 100} g (${data.spoolName || 'tekercs'})`);
          fetchData();
        } else if (data.type === 'assign') {
          toast.success(`${data.spoolName || 'Tekercs'} automatikusan hozzárendelve a tálcához`);
          fetchData();
        } else if (data.type === 'unassign') {
          toast.info(`${data.spoolName || 'Tekercs'} levéve a tálcáról`);
          fetchData();
        } else if (data.type === 'weight_sync') {
          fetchData();
        } else if (data.type === 'tray_change') {
          fetchData();
        } else if (data.type === 'alert_update') {
          setLowFilamentAlerts(data.alerts || []);
        }
      } catch (err) {
        console.error('Error parsing SSE message:', err);
      }
    };

    const connect = () => {
      eventSource = new EventSource('/api/events');
      eventSource.onmessage = handleSSEMessage;

      eventSource.onerror = () => {
        eventSource?.close();
        eventSource = null;
        if (!sseConnected) {
          // SSE never connected — go straight to polling
          if (sseCheckTimeout) {
            clearTimeout(sseCheckTimeout);
            sseCheckTimeout = null;
          }
          startPolling();
        } else {
          // Was working, try to reconnect after a delay
          reconnectTimeout = setTimeout(connect, 5000);
        }
      };
    };

    connect();

    // If SSE doesn't deliver a "connected" message within 4 seconds, fall back to polling
    sseCheckTimeout = setTimeout(() => {
      if (!sseConnected) {
        eventSource?.close();
        eventSource = null;
        startPolling();
      }
    }, 4000);

    return () => {
      eventSource?.close();
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (sseCheckTimeout) clearTimeout(sseCheckTimeout);
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [settings?.homeassistant, settings?.spoolman, fetchData]);

  const handleSpoolAssign = async (trayId: string, spoolId: number) => {
    try {
      const res = await fetch('/api/spools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trayId, spoolId }),
      });

      if (!res.ok) {
        throw new Error('Nem sikerült hozzárendelni a tekercset');
      }

      toast.success('Tekercs hozzárendelve');
      fetchData(); // Refresh data
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nem sikerült hozzárendelni a tekercset');
    }
  };

  const runAmsAction = async (action: 'create' | 'weights') => {
    setAmsAction(action);
    try {
      const res = await fetch(action === 'create' ? '/api/spools/sync-ams' : '/api/spools/sync-ams-weights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sikertelen művelet');
      const errors = data.errors?.length ? `, ${data.errors.length} hiba` : '';
      if (action === 'create') {
        toast.success(`Új tekercsek: ${data.created} felvéve, ${data.assigned} hozzárendelve, ${data.alreadyAssigned} már megvolt${errors}`);
      } else {
        toast.success(`Súlyok: ${data.updated?.length ?? 0} frissítve, ${data.unchanged} már egyezett, ${data.skipped} kihagyva${errors}`);
      }
      await fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sikertelen művelet');
    } finally {
      setAmsAction(null);
    }
  };

  const handleSpoolUnassign = async (spoolId: number) => {
    try {
      const res = await fetch('/api/spools', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spoolId }),
      });

      if (!res.ok) {
        throw new Error('Nem sikerült levenni a tekercset');
      }

      toast.success('Tekercs levéve');
      await fetchData(); // Refresh data - await to ensure UI updates
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nem sikerült levenni a tekercset');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Nav />
        <main className="w-full max-w-7xl mx-auto py-6 px-3 sm:px-4 md:px-6">
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        </main>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background">
        <Nav />
        <main className="w-full max-w-7xl mx-auto py-6 px-3 sm:px-4 md:px-6">
          <Card className="border-destructive">
            <CardHeader>
              <CardTitle className="text-destructive">Hiba</CardTitle>
            </CardHeader>
            <CardContent>
              <p>{error}</p>
              <Button onClick={fetchData} className="mt-4">
                Újra
              </Button>
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  // Show setup prompt if services aren't configured
  if (!settings?.homeassistant || !settings?.spoolman) {
    return (
      <div className="min-h-screen bg-background">
        <Nav />
        <main className="w-full max-w-7xl mx-auto py-6 px-3 sm:px-4 md:px-6">
          <Card>
            <CardHeader>
              <CardTitle>Üdv a SpoolmanSyncben</CardTitle>
              <CardDescription>
                Kezdéshez kösd be a Home Assistantot és a Spoolmant.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4">
                <div className={`h-3 w-3 rounded-full ${settings?.homeassistant ? 'bg-green-500' : 'bg-gray-300'}`} />
                <span>Home Assistant: {settings?.homeassistant ? 'Csatlakozva' : 'Nincs beállítva'}</span>
              </div>
              <div className="flex items-center gap-4">
                <div className={`h-3 w-3 rounded-full ${settings?.spoolman ? 'bg-green-500' : 'bg-gray-300'}`} />
                <span>Spoolman: {settings?.spoolman ? 'Csatlakozva' : 'Nincs beállítva'}</span>
              </div>
              <Link href="/settings">
                <Button>Beállítások</Button>
              </Link>
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="w-full max-w-7xl mx-auto py-6 px-3 sm:px-4 md:px-6">
        <div className="mb-4 sm:mb-6 flex items-center justify-between gap-2">
          <h1 className="text-xl sm:text-2xl font-bold">Áttekintés</h1>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={amsAction !== null}
              onClick={() => runAmsAction('create')}
              title="Az AMS-ben lévő, még fel nem vett Bambu RFID tekercseket felveszi a Spoolmanbe és hozzárendeli"
            >
              {amsAction === 'create' ? 'Felvétel…' : 'Új tekercsek az AMS-ből'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={amsAction !== null}
              onClick={() => runAmsAction('weights')}
              title="Az AMS-ben lévő RFID tekercsek maradék súlyát felülírja az AMS becslésével"
            >
              {amsAction === 'weights' ? 'Frissítés…' : 'Súlyok az AMS-ből'}
            </Button>
            <Button variant="outline" size="sm" onClick={fetchData}>
              Frissítés
            </Button>
          </div>
        </div>

        {printers.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Nincs nyomtató</CardTitle>
              <CardDescription>
                Ellenőrizd, hogy a Bambu Lab nyomtató be van-e kötve a Home Assistantba a ha-bambulab integrációval, és fel van-e véve a SpoolmanSync beállításaiban.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="space-y-6">
            {/* Warn when HA entity IDs changed since automations were configured */}
            {automationsStale && (
              <Alert variant="destructive">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
                  />
                </svg>
                <AlertTitle>Elavult automatizmusok</AlertTitle>
                <AlertDescription>
                  A Home Assistant entitásazonosítói megváltoztak az automatizmusok legutóbbi beállítása óta.
                  A tálcaváltás-figyelés és a fogyáskövetés nem biztos, hogy működik, amíg újra nem állítod őket.{' '}
                  <Link href="/automations" className="underline hover:no-underline font-medium">
                    Automatizmusok újrabeállítása
                  </Link>
                </AlertDescription>
              </Alert>
            )}

            {/* Show instruction banner when there are unassigned trays */}
            {unassignedTrays.length > 0 && (
              <Alert>
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <AlertTitle>Rendelj tekercset a tálcákhoz</AlertTitle>
                <AlertDescription>
                  <div className="space-y-1">
                    {unassignedTrays.map((tray) => {
                      const details = [tray.material, tray.name].filter(Boolean).join(' - ');
                      return (
                        <div key={tray.key}>
                          <strong>{tray.label}</strong>: van benne filament, de nincs hozzárendelt tekercs.
                          {details && (
                            <span>
                              {' '}AMS szerint: {details}
                              {tray.color && (
                                <span
                                  className="inline-block w-3 h-3 rounded-full ml-1 align-middle border border-border"
                                  style={{ backgroundColor: tray.color.startsWith('#') ? tray.color.substring(0, 7) : `#${tray.color.substring(0, 6)}` }}
                                />
                              )}
                            </span>
                          )}
                        </div>
                      );
                    })}
                    <div className="mt-1">
                      Kattints lent a tálcára, és válaszd ki, melyik Spoolman tekercs van benne.
                      Így a nyomtatások után pontos lesz a fogyáskövetés.
                    </div>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {/* Low filament stock alert banner */}
            {lowFilamentAlerts.length > 0 && (
              <Alert variant="destructive">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
                  />
                </svg>
                <AlertTitle>Fogyóban lévő filament</AlertTitle>
                <AlertDescription>
                  <div className="space-y-1">
                    {lowFilamentAlerts.map((alert) => (
                      <div key={alert.groupKey} className="flex items-center gap-2">
                        {alert.color_hex && (
                          <span
                            className="inline-block w-3 h-3 rounded-full border border-border shrink-0"
                            style={{ backgroundColor: alert.color_hex.startsWith('#') ? alert.color_hex : `#${alert.color_hex}` }}
                          />
                        )}
                        <span>
                          <strong>{alert.groupLabel}</strong>
                          {' '}&mdash;{' '}
                          {alert.spoolCount === 1
                            ? `${alert.lowestRemaining} g maradt`
                            : `${alert.spoolCount} tekercs, a legkevesebb: ${alert.lowestRemaining} g`
                          }
                          {alert.lowestPercentage > 0 && ` (${alert.lowestPercentage}%)`}
                        </span>
                      </div>
                    ))}
                    <div className="mt-1">
                      <Link href="/settings" className="underline hover:no-underline">
                        Riasztások beállítása
                      </Link>
                    </div>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {printers.map((printer) => (
              <PrinterCard
                key={printer.entity_id}
                printer={printer as Parameters<typeof PrinterCard>[0]['printer']}
                spools={spools}
                onSpoolAssign={handleSpoolAssign}
                onSpoolUnassign={handleSpoolUnassign}
                showSpoolLocation={settings?.showSpoolLocation}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
