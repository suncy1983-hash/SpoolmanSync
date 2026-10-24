'use client';

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Nav } from '@/components/nav';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { AddPrinterDialog } from '@/components/add-printer-dialog';
import type { AlertConfig, ActiveAlert, AvailableGroup } from '@/lib/alerts';

interface FilterField {
  key: string;
  name: string;
  values: string[];
  builtIn: boolean;
}

interface AdminCredentials {
  username: string;
  hasPassword: boolean;
}

interface Settings {
  embeddedMode: boolean;
  addonMode?: boolean;
  homeassistant: {
    url: string;
    connected: boolean;
    adminCredentials?: AdminCredentials | null;
    error?: string;
  } | null;
  spoolman: { url: string; connected: boolean } | null;
  neverAutoClearTray?: boolean;
  autoCreateSpools?: boolean;
  ignoreColorMismatch?: boolean;
  webhookConfigured?: boolean;
}

interface ConfigEntry {
  entry_id: string;
  domain: string;
  title: string;
  state: string;
}

interface VirtualPrinterSlot {
  id: string;
  number: number;
}

interface VirtualPrinter {
  id: string;
  name: string;
  slots: VirtualPrinterSlot[];
}

function SettingsContent() {
  const searchParams = useSearchParams();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);

  // Form states
  const [haUrl, setHaUrl] = useState('');
  const [spoolmanUrl, setSpoolmanUrl] = useState('');
  const [saving, setSaving] = useState<'ha' | 'spoolman' | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Printer states
  const [printers, setPrinters] = useState<ConfigEntry[]>([]);
  const [hiddenPrinters, setHiddenPrinters] = useState<ConfigEntry[]>([]);
  const [addPrinterOpen, setAddPrinterOpen] = useState(false);
  const [removingPrinter, setRemovingPrinter] = useState<string | null>(null);
  const [readdingPrinter, setReaddingPrinter] = useState<string | null>(null);

  // Admin credentials state (embedded mode)
  // Password is no longer returned on load; it is fetched on demand via the reveal endpoint.
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);
  const [revealingPassword, setRevealingPassword] = useState(false);

  // Reconnect form state (embedded mode, broken connection)
  const [reconnectUsername, setReconnectUsername] = useState('admin');
  const [reconnectPassword, setReconnectPassword] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState('');

  // Filter configuration states
  const [filterFields, setFilterFields] = useState<FilterField[]>([]);
  const [enabledFilters, setEnabledFilters] = useState<string[]>([]);
  const [savingFilters, setSavingFilters] = useState(false);

  // Dashboard display settings
  const [showSpoolLocation, setShowSpoolLocation] = useState(false);

  // Sync behavior settings
  const [neverAutoClearTray, setNeverAutoClearTray] = useState(false);
  const [autoCreateSpools, setAutoCreateSpools] = useState(true);
  const [amsSyncing, setAmsSyncing] = useState(false);
  const [ignoreColorMismatch, setIgnoreColorMismatch] = useState(false);
  const [syncSpoolmanLocation, setSyncSpoolmanLocation] = useState(false);
  const [locationGranularity, setLocationGranularity] = useState<'tray' | 'ams'>('tray');
  // Optional "holding pen" for unassigned spools. Empty = clear the location
  // (the original behavior). Only has any effect while location sync is on.
  const [unassignedSpoolLocation, setUnassignedSpoolLocation] = useState('');
  const [savedUnassignedLocation, setSavedUnassignedLocation] = useState('');
  const seededUnassignedLocation = useRef(false);

  // QR base URL state
  const [qrBaseUrl, setQrBaseUrl] = useState('');
  const [savingQrUrl, setSavingQrUrl] = useState(false);

  // Alert configuration states
  const [alertConfig, setAlertConfig] = useState<AlertConfig>({
    enabled: false,
    thresholdType: 'percentage',
    thresholdValue: 10,
    groupingStrategy: 'material',
  });
  const [activeAlerts, setActiveAlerts] = useState<ActiveAlert[]>([]);
  const [availableGroups, setAvailableGroups] = useState<AvailableGroup[]>([]);
  const [savingAlerts, setSavingAlerts] = useState(false);

  // Virtual printers states
  const [virtualPrinters, setVirtualPrinters] = useState<VirtualPrinter[]>([]);
  const [newVpName, setNewVpName] = useState('');
  const [newVpSlotCount, setNewVpSlotCount] = useState(1);
  const [existingLocations, setExistingLocations] = useState<string[]>([]);
  const [creatingVp, setCreatingVp] = useState(false);
  const [mutatingVp, setMutatingVp] = useState<string | null>(null);
  const [editingVpName, setEditingVpName] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchSettings();
    fetchVirtualPrinters();
    fetchExistingLocations();

    // Handle OAuth callback messages
    const success = searchParams.get('success');
    const error = searchParams.get('error');

    if (success === 'ha_connected') {
      toast.success('Home Assistant csatlakoztatva');
      window.history.replaceState({}, '', '/settings');
    } else if (error) {
      const errorMessages: Record<string, string> = {
        missing_params: 'Az OAuth visszahívásból hiányoznak paraméterek',
        invalid_state: 'Érvénytelen OAuth állapot – próbáld újra',
        token_exchange_failed: 'Nem sikerült beváltani az engedélyezési kódot',
        oauth_failed: 'Sikertelen OAuth hitelesítés',
        ha_unreachable: 'A SpoolmanSync konténer nem éri el a Home Assistantot. Nem elég, hogy a böngésződ eléri – ellenőrizd a Docker hálózatot és a tűzfalat.',
      };
      toast.error(errorMessages[error] || 'Sikertelen hitelesítés');
      window.history.replaceState({}, '', '/settings');
    }
  }, [searchParams]);

  // Fetch printers when HA is connected, and poll to stay in sync
  // with changes made directly in HA (e.g. printer added/removed in ha-bambulab)
  useEffect(() => {
    if (settings?.homeassistant?.connected) {
      fetchPrinters();
      const interval = setInterval(fetchPrinters, 10000);
      return () => clearInterval(interval);
    }
  }, [settings?.homeassistant?.connected]);

  // Fetch filter fields and alert config when Spoolman is connected
  useEffect(() => {
    if (settings?.spoolman) {
      fetchFilterFields();
      fetchAlertConfig();
    }
  }, [settings?.spoolman]);

  // Refresh the Spoolman location suggestions whenever this tab regains focus.
  // Locations are managed in Spoolman, out of band from this app — without this
  // the datalist stays frozen at whatever it was when the page mounted, so
  // locations added or removed in another tab never show up.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') fetchExistingLocations();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  // Auto-refresh settings when in embedded mode and waiting for HA
  useEffect(() => {
    if (settings?.embeddedMode && !settings?.homeassistant && !loading) {
      const interval = setInterval(() => {
        fetchSettings();
      }, 3000); // Poll every 3 seconds
      return () => clearInterval(interval);
    }
  }, [settings?.embeddedMode, settings?.homeassistant, loading]);

  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      setSettings(data);

      if (data.homeassistant) {
        setHaUrl(data.homeassistant.url);
      }
      if (data.spoolman) {
        setSpoolmanUrl(data.spoolman.url);
      }
      if (data.qrBaseUrl !== undefined) {
        setQrBaseUrl(data.qrBaseUrl);
      }
      if (data.showSpoolLocation !== undefined) {
        setShowSpoolLocation(data.showSpoolLocation);
      }
      if (data.ignoreColorMismatch !== undefined) {
        setIgnoreColorMismatch(data.ignoreColorMismatch);
      }
      if (data.autoCreateSpools !== undefined) {
        setAutoCreateSpools(data.autoCreateSpools);
      }
      if (data.neverAutoClearTray !== undefined) {
        setNeverAutoClearTray(data.neverAutoClearTray);
      }
      if (data.syncSpoolmanLocation !== undefined) {
        setSyncSpoolmanLocation(data.syncSpoolmanLocation);
      }
      if (data.locationGranularity === 'tray' || data.locationGranularity === 'ams') {
        setLocationGranularity(data.locationGranularity);
      }
      // Seed once. fetchSettings() also runs on a 3s poll in embedded mode while
      // HA finishes onboarding, and this is a controlled input saved on blur —
      // re-seeding on every poll would wipe whatever is being typed before it
      // could ever be saved. Nothing else writes this value, and
      // saveUnassignedLocation() keeps both states current after a save.
      if (data.unassignedSpoolLocation !== undefined && !seededUnassignedLocation.current) {
        seededUnassignedLocation.current = true;
        setUnassignedSpoolLocation(data.unassignedSpoolLocation);
        setSavedUnassignedLocation(data.unassignedSpoolLocation);
      }
    } catch {
      toast.error('Nem sikerült betölteni a beállításokat');
    } finally {
      setLoading(false);
    }
  };

  const fetchPrinters = async () => {
    try {
      const res = await fetch('/api/printers/setup');
      if (res.ok) {
        const data = await res.json();
        setPrinters(data.entries || []);
        setHiddenPrinters(data.hiddenEntries || []);
      }
    } catch {
      // Silently fail - HA might not be connected yet
    }
  };

  const removePrinter = async (entryId: string) => {
    setRemovingPrinter(entryId);
    try {
      const res = await fetch('/api/printers/setup', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId }),
      });

      if (!res.ok) {
        throw new Error('Nem sikerült eltávolítani a nyomtatót');
      }

      toast.success('Nyomtató eltávolítva');
      fetchPrinters();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nem sikerült eltávolítani a nyomtatót');
    } finally {
      setRemovingPrinter(null);
    }
  };

  const readdPrinter = async (entryId: string) => {
    setReaddingPrinter(entryId);
    try {
      const res = await fetch('/api/printers/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unhide', entryId }),
      });

      if (!res.ok) {
        throw new Error('Nem sikerült visszavenni a nyomtatót');
      }

      toast.success('Nyomtató visszavéve a SpoolmanSyncbe');
      fetchPrinters();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nem sikerült visszavenni a nyomtatót');
    } finally {
      setReaddingPrinter(null);
    }
  };

  const connectHomeAssistant = async () => {
    if (!haUrl) {
      toast.error('Add meg a Home Assistant címét');
      return;
    }

    setConnecting(true);
    try {
      const res = await fetch(`/api/auth/ha?ha_url=${encodeURIComponent(haUrl)}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Nem sikerült elindítani a hitelesítést');
      }

      window.location.href = data.authUrl;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nem sikerült csatlakozni a Home Assistanthoz');
      setConnecting(false);
    }
  };

  const disconnectHomeAssistant = async () => {
    setSaving('ha');
    try {
      const res = await fetch('/api/settings', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'homeassistant' }),
      });

      if (!res.ok) {
        throw new Error('Nem sikerült bontani a kapcsolatot');
      }

      toast.success('Home Assistant leválasztva');
      setSettings(prev => prev ? { ...prev, homeassistant: null } : null);
      setHaUrl('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nem sikerült bontani a kapcsolatot');
    } finally {
      setSaving(null);
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} a vágólapra másolva`);
    } catch {
      toast.error('Nem sikerült a vágólapra másolni');
    }
  };

  const revealPassword = async () => {
    setRevealingPassword(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'reveal_ha_password' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Nem sikerült megjeleníteni a jelszót');
      }
      const data = await res.json();
      setRevealedPassword(data.password ?? '');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nem sikerült megjeleníteni a jelszót');
    } finally {
      setRevealingPassword(false);
    }
  };

  const reconnectHomeAssistant = async () => {
    if (!reconnectPassword) {
      toast.error('Add meg a Home Assistant jelszavát');
      return;
    }

    setReconnecting(true);
    setReconnectError('');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'reconnect_ha',
          username: reconnectUsername,
          password: reconnectPassword,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Nem sikerült újracsatlakozni');
      }

      toast.success('Újracsatlakozva a Home Assistanthoz');
      setReconnectPassword('');
      setReconnectError('');
      fetchSettings();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Nem sikerült újracsatlakozni';
      setReconnectError(message);
      toast.error(message);
    } finally {
      setReconnecting(false);
    }
  };

  const saveSpoolmanSettings = async () => {
    setSaving('spoolman');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'spoolman',
          url: spoolmanUrl,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Nem sikerült menteni');
      }

      toast.success('Spoolman csatlakoztatva');
      fetchSettings();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nem sikerült csatlakozni a Spoolmanhez');
    } finally {
      setSaving(null);
    }
  };

  const fetchFilterFields = async () => {
    try {
      const res = await fetch('/api/spools/extra-fields');
      if (res.ok) {
        const data = await res.json();
        setFilterFields(data.fields || []);
        setEnabledFilters(data.filterConfig || []);
      }
    } catch {
      // Silently fail - Spoolman might not be connected yet
    }
  };

  const saveFilterConfig = async (newConfig: string[]) => {
    setSavingFilters(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'filter_config',
          config: newConfig,
        }),
      });

      if (!res.ok) {
        throw new Error('Nem sikerült menteni a szűrőbeállításokat');
      }

      setEnabledFilters(newConfig);
      toast.success('Szűrőbeállítások mentve');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nem sikerült menteni a szűrőbeállításokat');
    } finally {
      setSavingFilters(false);
    }
  };

  const toggleFilter = (fieldKey: string) => {
    const newConfig = enabledFilters.includes(fieldKey)
      ? enabledFilters.filter((k) => k !== fieldKey)
      : [...enabledFilters, fieldKey];
    saveFilterConfig(newConfig);
  };

  const fetchAlertConfig = async () => {
    try {
      const res = await fetch('/api/alerts');
      if (res.ok) {
        const data = await res.json();
        if (data.config) setAlertConfig(data.config);
        if (data.alerts) setActiveAlerts(data.alerts);
        if (data.availableGroups) setAvailableGroups(data.availableGroups);
      }
    } catch {
      // Silently fail
    }
  };

  const fetchAvailableGroups = async (strategy: string) => {
    try {
      const res = await fetch(`/api/alerts?strategy=${encodeURIComponent(strategy)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.availableGroups) setAvailableGroups(data.availableGroups);
      }
    } catch {
      // Silently fail
    }
  };

  const saveAlertSettings = async () => {
    setSavingAlerts(true);
    try {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alertConfig),
      });

      if (!res.ok) {
        throw new Error('Nem sikerült menteni a riasztási beállításokat');
      }

      const data = await res.json();
      if (data.alerts) setActiveAlerts(data.alerts);
      toast.success('Riasztási beállítások mentve');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nem sikerült menteni a riasztási beállításokat');
    } finally {
      setSavingAlerts(false);
    }
  };

  const fetchVirtualPrinters = async () => {
    try {
      const res = await fetch('/api/virtual-printers');
      if (res.ok) {
        const data = await res.json();
        setVirtualPrinters(data.virtualPrinters || []);
      }
    } catch {
      // Silently fail
    }
  };

  /**
   * Persist the holding-pen location on blur. No-op when nothing changed, so
   * tabbing through the field doesn't spam the API or the user with toasts.
   * Reverts the input on failure rather than leaving it showing an unsaved value.
   */
  const saveLocationGranularity = async (granularity: 'tray' | 'ams') => {
    const previous = locationGranularity;
    setLocationGranularity(granularity); // optimistic, reverted below on failure
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'location_granularity', granularity }),
      });
      if (!res.ok) throw new Error();
      toast.success(
        granularity === 'ams'
          ? 'A tekercsek helye AMS egységenként lesz megadva'
          : 'A tekercsek helye tálcánként lesz megadva'
      );
    } catch {
      setLocationGranularity(previous);
      toast.error('Nem sikerült menteni a hely részletességét');
    }
  };

  const saveUnassignedLocation = async () => {
    const location = unassignedSpoolLocation.trim();
    if (location === savedUnassignedLocation) {
      setUnassignedSpoolLocation(location); // normalize whitespace-only edits
      return;
    }

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'unassigned_spool_location', location }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const saved = typeof data.location === 'string' ? data.location : location;
      setUnassignedSpoolLocation(saved);
      setSavedUnassignedLocation(saved);
      toast.success(
        saved
          ? `A levett tekercsek helye: "${saved}"`
          : 'A levett tekercsek helye törlődik'
      );
    } catch {
      setUnassignedSpoolLocation(savedUnassignedLocation);
      toast.error('Nem sikerült menteni a beállítást');
    }
  };

  const fetchExistingLocations = async () => {
    try {
      const res = await fetch('/api/spoolman/locations', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setExistingLocations(Array.isArray(data.locations) ? data.locations : []);
      }
    } catch {
      // Silently fail — suggestions are optional
    }
  };

  const createVirtualPrinter = async () => {
    const name = newVpName.trim();
    if (!name) {
      toast.error('Adj nevet a virtuális nyomtatónak');
      return;
    }

    setCreatingVp(true);
    try {
      const res = await fetch('/api/virtual-printers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, slotCount: newVpSlotCount }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Nem sikerült létrehozni a virtuális nyomtatót');
      }

      toast.success('Virtuális nyomtató létrehozva');
      setNewVpName('');
      setNewVpSlotCount(1);
      fetchVirtualPrinters();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nem sikerült létrehozni a virtuális nyomtatót');
    } finally {
      setCreatingVp(false);
    }
  };

  const patchVirtualPrinter = async (
    id: string,
    changes: { name?: string; action?: 'addSlot' | 'removeSlot'; slotNumber?: number },
    successMessage: string,
  ) => {
    setMutatingVp(id);
    try {
      const res = await fetch('/api/virtual-printers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...changes }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Nem sikerült módosítani a virtuális nyomtatót');
      }

      toast.success(successMessage);
      fetchVirtualPrinters();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nem sikerült módosítani a virtuális nyomtatót');
    } finally {
      setMutatingVp(null);
    }
  };

  const renameVirtualPrinter = (vp: VirtualPrinter) => {
    const name = (editingVpName[vp.id] ?? vp.name).trim();
    if (!name) {
      toast.error('A név nem lehet üres');
      return;
    }
    if (name === vp.name) return;
    patchVirtualPrinter(vp.id, { name }, 'Virtuális nyomtató átnevezve');
  };

  const addVirtualPrinterSlot = (vp: VirtualPrinter) => {
    if (vp.slots.length >= 16) {
      toast.error('Legfeljebb 16 hely lehet');
      return;
    }
    patchVirtualPrinter(vp.id, { action: 'addSlot' }, 'Hely hozzáadva');
  };

  const removeVirtualPrinterSlot = (vp: VirtualPrinter, slotNumber: number) => {
    patchVirtualPrinter(vp.id, { action: 'removeSlot', slotNumber }, 'Hely eltávolítva');
  };

  const deleteVirtualPrinter = async (vp: VirtualPrinter) => {
    if (!window.confirm(`Delete "${vp.name}"? Any spool assignments to its slots will be cleared.`)) {
      return;
    }
    setMutatingVp(vp.id);
    try {
      const res = await fetch('/api/virtual-printers', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: vp.id }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Nem sikerült törölni a virtuális nyomtatót');
      }

      toast.success('Virtuális nyomtató törölve');
      fetchVirtualPrinters();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nem sikerült törölni a virtuális nyomtatót');
    } finally {
      setMutatingVp(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Nav />
        <main className="w-full max-w-2xl mx-auto py-6 px-3 sm:px-4 md:px-6">
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="w-full max-w-2xl mx-auto py-6 px-3 sm:px-4 md:px-6">
        <h1 className="text-xl sm:text-2xl font-bold mb-6">Beállítások</h1>

        <div className="space-y-6">
          {/* Home Assistant Settings */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <div className={`h-3 w-3 rounded-full ${
                  settings?.homeassistant?.connected ? 'bg-green-500'
                    : settings?.homeassistant?.error ? 'bg-orange-500'
                    : 'bg-gray-300'
                }`} />
                <CardTitle>Home Assistant</CardTitle>
                {settings?.embeddedMode && (
                  <span className="text-xs bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded">
                    Beépített
                  </span>
                )}
                {settings?.addonMode && (
                  <span className="text-xs bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 px-2 py-0.5 rounded">
                    Add-on
                  </span>
                )}
              </div>
              <CardDescription>
                {settings?.addonMode
                  ? 'Connected automatically via Home Assistant Supervisor.'
                  : settings?.embeddedMode
                    ? 'Home Assistant is bundled with SpoolmanSync and auto-configured.'
                    : 'Csatlakozz a Home Assistanthoz a Bambu Lab nyomtatók felderítéséhez.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {settings?.addonMode ? (
                // Add-on mode - HA connection is automatic via Supervisor
                <div className="space-y-4">
                  {settings?.homeassistant ? (
                    <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                      <div>
                        <p className="font-medium text-green-600 dark:text-green-400">Csatlakozva a Supervisoron keresztül</p>
                        <p className="text-sm text-muted-foreground">
                          A SpoolmanSync Home Assistant add-onként fut, automatikus API-hozzáféréssel.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                      <p className="font-medium text-yellow-700 dark:text-yellow-400">Csatlakozás a Home Assistanthoz...</p>
                      <p className="text-sm text-yellow-600 dark:text-yellow-500 mt-1">
                        A Supervisor kapcsolat felépítése folyamatban.
                      </p>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    A Bambu Lab integrációt HACS-ból kell telepíteni a Home Assistantba.
                    A nyomtatókat lent, a Bambu Lab résznél veheted fel.
                  </p>
                </div>
              ) : settings?.embeddedMode ? (
                // Embedded mode - show status and admin credentials
                <div className="space-y-4">
                  {settings?.homeassistant?.connected ? (
                    // State 1: Connected
                    <>
                      <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                        <div>
                          <p className="font-medium text-green-600 dark:text-green-400">Csatlakozva</p>
                          <p className="text-sm text-muted-foreground">{settings.homeassistant.url}</p>
                        </div>
                      </div>

                      {/* Admin Credentials Section */}
                      {settings.homeassistant.adminCredentials ? (
                        <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg space-y-3">
                          <div>
                            <p className="font-medium text-blue-700 dark:text-blue-300">Home Assistant bejelentkezés</p>
                            <p className="text-sm text-blue-600 dark:text-blue-400 mt-1">
                              Use these credentials to access Home Assistant directly at{' '}
                              <a
                                href="http://localhost:8123"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline hover:no-underline"
                              >
                                localhost:8123
                              </a>
                            </p>
                          </div>

                          <div className="grid gap-2">
                            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-2">
                              <span className="text-sm text-muted-foreground">Felhasználónév:</span>
                              <div className="flex items-center gap-2">
                                <code className="px-2 py-1 bg-background rounded text-sm truncate max-w-[150px] sm:max-w-none">
                                  {settings.homeassistant.adminCredentials.username}
                                </code>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 shrink-0"
                                  onClick={() => copyToClipboard(settings.homeassistant!.adminCredentials!.username, 'Username')}
                                >
                                  Másolás
                                </Button>
                              </div>
                            </div>
                            {settings.homeassistant.adminCredentials.hasPassword ? (
                              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-2">
                                <span className="text-sm text-muted-foreground">Jelszó:</span>
                                <div className="flex items-center gap-2">
                                  <code className="px-2 py-1 bg-background rounded text-sm font-mono truncate max-w-[150px] sm:max-w-none">
                                    {revealedPassword !== null ? revealedPassword : '••••••••••••'}
                                  </code>
                                  {revealedPassword !== null ? (
                                    <>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 px-2 shrink-0"
                                        onClick={() => setRevealedPassword(null)}
                                      >
                                        Elrejtés
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 px-2 shrink-0"
                                        onClick={() => copyToClipboard(revealedPassword, 'Password')}
                                      >
                                        Másolás
                                      </Button>
                                    </>
                                  ) : (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 px-2 shrink-0"
                                      onClick={revealPassword}
                                      disabled={revealingPassword}
                                    >
                                      {revealingPassword ? 'Megjelenítés...' : 'Jelszó megjelenítése'}
                                    </Button>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-2">
                                <span className="text-sm text-muted-foreground">Jelszó:</span>
                                <span className="text-sm text-muted-foreground italic">
                                  Nincs tárolt jelszó
                                </span>
                              </div>
                            )}
                          </div>

                          <p className="text-xs text-muted-foreground pt-2 border-t border-blue-200 dark:border-blue-800">
                            Ha megváltoztatod a jelszót a Home Assistantban, itt az új jelszóval újracsatlakozhatsz.
                          </p>
                        </div>
                      ) : (
                        <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                          <p className="font-medium text-blue-700 dark:text-blue-300">Home Assistant bejelentkezés</p>
                          <p className="text-sm text-blue-600 dark:text-blue-400 mt-1">
                            No stored admin credentials are available. You can still access Home Assistant directly at{' '}
                            <a
                              href="http://localhost:8123"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline hover:no-underline"
                            >
                              localhost:8123
                            </a>
                            {' '}using the credentials you set up.
                          </p>
                        </div>
                      )}
                    </>
                  ) : settings?.homeassistant?.error ? (
                    // State 3: Connection broken (token invalid, password may have changed)
                    <div className="p-4 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg space-y-3">
                      <div>
                        <p className="font-medium text-orange-700 dark:text-orange-400">Megszakadt a kapcsolat</p>
                        <p className="text-sm text-orange-600 dark:text-orange-500 mt-1">
                          A Home Assistant kapcsolati token már nem érvényes.
                          Ez általában a HA jelszó megváltoztatása után fordul elő.
                          Add meg a jelenlegi Home Assistant belépési adataidat az újracsatlakozáshoz.
                        </p>
                      </div>

                      <div className="space-y-3">
                        <div className="space-y-1">
                          <Label htmlFor="reconnect-username">Felhasználónév</Label>
                          <Input
                            id="reconnect-username"
                            value={reconnectUsername}
                            onChange={(e) => setReconnectUsername(e.target.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="reconnect-password">Jelszó</Label>
                          <Input
                            id="reconnect-password"
                            type="password"
                            value={reconnectPassword}
                            onChange={(e) => setReconnectPassword(e.target.value)}
                            placeholder="HA jelszó"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') reconnectHomeAssistant();
                            }}
                          />
                        </div>
                        {reconnectError && (
                          <p className="text-sm text-red-600 dark:text-red-400">{reconnectError}</p>
                        )}
                        <Button
                          onClick={reconnectHomeAssistant}
                          disabled={reconnecting || !reconnectPassword}
                        >
                          {reconnecting ? 'Reconnecting...' : 'Reconnect'}
                        </Button>
                      </div>
                    </div>
                  ) : !settings?.homeassistant ? (
                    // State 2: HA still starting up (no connection yet)
                    <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                      <p className="font-medium text-yellow-700 dark:text-yellow-400">Csatlakozás a Home Assistanthoz...</p>
                      <p className="text-sm text-yellow-600 dark:text-yellow-500 mt-1">
                        A Home Assistant indul, és automatikusan beállítja magát.
                        Első indításkor ez akár egy percig is tarthat.
                      </p>
                      <div className="flex items-center gap-2 mt-3">
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-yellow-600" />
                        <Button variant="outline" size="sm" onClick={fetchSettings}>
                          Állapot frissítése
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    A beépített Home Assistantban a HACS és a Bambu Lab integráció előre be van állítva.
                    A nyomtatókat lent, a Bambu Lab résznél veheted fel.
                  </p>
                </div>
              ) : settings?.homeassistant ? (
                // External mode - connected
                <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                  <div>
                    <p className="font-medium">Csatlakozva</p>
                    <p className="text-sm text-muted-foreground">{settings.homeassistant.url}</p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={disconnectHomeAssistant}
                    disabled={saving === 'ha'}
                  >
                    {saving === 'ha' ? 'Disconnecting...' : 'Disconnect'}
                  </Button>
                </div>
              ) : (
                // External mode - not connected
                <>
                  <div className="space-y-2">
                    <Label htmlFor="ha-url">Home Assistant címe</Label>
                    <Input
                      id="ha-url"
                      placeholder="http://homeassistant.local:8123"
                      value={haUrl}
                      onChange={(e) => setHaUrl(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Add meg a Home Assistant címét, majd kattints a Csatlakozásra az engedélyezéshez.
                    </p>
                  </div>
                  <Button
                    onClick={connectHomeAssistant}
                    disabled={connecting || !haUrl}
                  >
                    {connecting ? 'Átirányítás...' : 'Csatlakozás a Home Assistanthoz'}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          <Separator />

          {/* Bambu Lab Printers */}
          {settings?.homeassistant?.connected && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Bambu Lab nyomtatók</CardTitle>
                    <CardDescription>
                      A Spoolmannel szinkronizált Bambu Lab nyomtatók beállítása.
                    </CardDescription>
                  </div>
                  <Button onClick={() => setAddPrinterOpen(true)}>
                    Nyomtató hozzáadása
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {printers.length === 0 && hiddenPrinters.length === 0 && (
                    <div className="text-center py-6 text-muted-foreground">
                      <p>Még nincs beállított nyomtató.</p>
                      <p className="text-sm mt-1">Kattints a &quot;Nyomtató hozzáadása&quot; gombra a Bambu Lab nyomtató bekötéséhez.</p>
                    </div>
                  )}
                  {printers.map((printer) => (
                    <div
                      key={printer.entry_id}
                      className="flex items-center justify-between p-3 bg-muted rounded-lg"
                    >
                      <div>
                        <p className="font-medium">{printer.title}</p>
                        <p className="text-sm text-muted-foreground">
                          {printer.state === 'loaded' ? (
                            <span className="text-green-600 dark:text-green-400">Csatlakozva</span>
                          ) : (
                            <span className="text-yellow-600 dark:text-yellow-400">{printer.state}</span>
                          )}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => removePrinter(printer.entry_id)}
                        disabled={removingPrinter === printer.entry_id}
                      >
                        {removingPrinter === printer.entry_id ? 'Removing...' : 'Remove'}
                      </Button>
                    </div>
                  ))}
                  {hiddenPrinters.length > 0 && (
                    <div className={printers.length > 0 ? 'pt-2 border-t' : ''}>
                      <p className="text-xs text-muted-foreground mb-2">
                        Eltávolítva a SpoolmanSyncből (a Home Assistantban még megvan):
                      </p>
                      {hiddenPrinters.map((printer) => (
                        <div
                          key={printer.entry_id}
                          className="flex items-center justify-between p-3 bg-muted/50 rounded-lg border border-dashed"
                        >
                          <div>
                            <p className="font-medium text-muted-foreground">{printer.title}</p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => readdPrinter(printer.entry_id)}
                            disabled={readdingPrinter === printer.entry_id}
                          >
                            {readdingPrinter === printer.entry_id ? 'Hozzáadás...' : 'Visszavétel'}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  {settings?.webhookConfigured && (
                    <p className="text-xs text-muted-foreground pt-2 border-t">
                      Webhook hitelesítés: bekapcsolva
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {settings?.homeassistant?.connected && <Separator />}

          {/* Virtual Printers */}
          <Card>
            <CardHeader>
              <CardTitle>Virtuális nyomtatók</CardTitle>
              <CardDescription>
                Tárolóhelyek – például szárító, száraz doboz vagy polc – hozzárendelhető helyekkel.
                Az áttekintésben hozzárendelhető helyként jelennek meg a QR/NFC készletkezeléshez; fogyást nem követnek.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {virtualPrinters.length === 0 && (
                  <div className="text-center py-6 text-muted-foreground">
                    <p>Még nincs virtuális nyomtató.</p>
                    <p className="text-sm mt-1">Hozz létre egyet lent a nyomtatón kívül tárolt filamentekhez.</p>
                  </div>
                )}

                {virtualPrinters.map((vp) => (
                  <div key={vp.id} className="p-3 bg-muted rounded-lg space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <Input
                        value={editingVpName[vp.id] ?? vp.name}
                        onChange={(e) =>
                          setEditingVpName((prev) => ({ ...prev, [vp.id]: e.target.value }))
                        }
                        onBlur={() => renameVirtualPrinter(vp)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                        disabled={mutatingVp === vp.id}
                        className="font-medium bg-background"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onClick={() => deleteVirtualPrinter(vp)}
                        disabled={mutatingVp === vp.id}
                      >
                        Törlés
                      </Button>
                    </div>

                    <div>
                      <p className="text-xs text-muted-foreground mb-2">
                        {vp.slots.length} hely
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {vp.slots.map((slot) => (
                          <span
                            key={slot.id}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-background rounded text-sm"
                          >
                            {slot.number}. hely
                            <button
                              type="button"
                              aria-label={`${slot.number}. hely eltávolítása`}
                              className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                              onClick={() => removeVirtualPrinterSlot(vp, slot.number)}
                              disabled={mutatingVp === vp.id}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7"
                          onClick={() => addVirtualPrinterSlot(vp)}
                          disabled={mutatingVp === vp.id || vp.slots.length >= 16}
                        >
                          + Hely hozzáadása
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}

                {/* Create new virtual printer */}
                <div className="pt-3 border-t space-y-3">
                  <p className="text-sm font-medium">Virtuális nyomtató hozzáadása</p>
                  <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                    <div className="flex-1 space-y-1">
                      <Label htmlFor="new-vp-name">Név</Label>
                      <Input
                        id="new-vp-name"
                        placeholder="pl. Száraz doboz A"
                        value={newVpName}
                        onChange={(e) => setNewVpName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') createVirtualPrinter();
                        }}
                        list="existing-spoolman-locations"
                      />
                      {existingLocations.length > 0 && (
                        <datalist id="existing-spoolman-locations">
                          {existingLocations.map((loc) => (
                            <option key={loc} value={loc} />
                          ))}
                        </datalist>
                      )}
                      {existingLocations.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          Tipp: válassz meglévő Spoolman helyet, hogy a nevek egyezzenek.
                        </p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="new-vp-slots">Helyek</Label>
                      <Input
                        id="new-vp-slots"
                        type="number"
                        min={1}
                        max={16}
                        value={newVpSlotCount}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          setNewVpSlotCount(Number.isNaN(n) ? 1 : Math.min(16, Math.max(1, n)));
                        }}
                        className="w-24"
                      />
                    </div>
                    <Button
                      onClick={createVirtualPrinter}
                      disabled={creatingVp || !newVpName.trim()}
                    >
                      {creatingVp ? 'Létrehozás...' : 'Létrehozás'}
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Separator />

          {/* Spoolman Settings */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <div className={`h-3 w-3 rounded-full ${settings?.spoolman ? 'bg-green-500' : 'bg-gray-300'}`} />
                <CardTitle>Spoolman</CardTitle>
              </div>
              <CardDescription>
                Csatlakozz a Spoolmanhez a filament tekercsek kezeléséhez.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="spoolman-url">Spoolman címe</Label>
                <Input
                  id="spoolman-url"
                  placeholder="http://localhost:7912"
                  value={spoolmanUrl}
                  onChange={(e) => setSpoolmanUrl(e.target.value)}
                />
              </div>
              <Button
                onClick={saveSpoolmanSettings}
                disabled={saving === 'spoolman' || !spoolmanUrl}
              >
                {saving === 'spoolman' ? 'Csatlakozás...' : settings?.spoolman ? 'Kapcsolat frissítése' : 'Csatlakozás'}
              </Button>
            </CardContent>
          </Card>

          {/* Dashboard Display Settings */}
          {settings?.spoolman && (
            <>
              <Separator />
              <Card>
                <CardHeader>
                  <CardTitle>Megjelenítés és működés</CardTitle>
                  <CardDescription>
                    Mi jelenjen meg a tekercs-kártyákon, és hogyan kezelje a SpoolmanSync a tálcákat.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center space-x-3">
                    <Checkbox
                      id="show-spool-location"
                      checked={showSpoolLocation}
                      onCheckedChange={async (checked) => {
                        const enabled = checked === true;
                        setShowSpoolLocation(enabled);
                        try {
                          const res = await fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ type: 'show_spool_location', enabled }),
                          });
                          if (!res.ok) throw new Error();
                          toast.success(enabled ? 'A tekercs helye megjelenik' : 'A tekercs helye rejtve');
                        } catch {
                          setShowSpoolLocation(!enabled);
                          toast.error('Nem sikerült menteni a beállítást');
                        }
                      }}
                    />
                    <div>
                      <Label htmlFor="show-spool-location" className="text-sm font-medium cursor-pointer">
                        Tekercs helyének megjelenítése
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        A Spoolman hely mező megjelenítése a tekercs-kártyákon (pl. polc, száraz doboz, rekesz)
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start space-x-3">
                    <Checkbox
                      id="auto-create-spools"
                      className="mt-1"
                      checked={autoCreateSpools}
                      onCheckedChange={async (checked) => {
                        const enabled = checked === true;
                        setAutoCreateSpools(enabled);
                        try {
                          const res = await fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ type: 'auto_create_spools', enabled }),
                          });
                          if (!res.ok) throw new Error();
                          toast.success(enabled ? 'Az új Bambu RFID tekercsek automatikusan bekerülnek a Spoolmanbe' : 'Automatikus tekercsfelvétel kikapcsolva');
                        } catch {
                          setAutoCreateSpools(!enabled);
                          toast.error('Nem sikerült menteni a beállítást');
                        }
                      }}
                    />
                    <div className="space-y-2">
                      <div>
                        <Label htmlFor="auto-create-spools" className="text-sm font-medium cursor-pointer">
                          Bambu tekercsek automatikus felvétele az AMS RFID alapján
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          Ha az AMS-be olyan Bambu RFID tekercs kerül, amelynek sorozatszáma nincs a Spoolmanben, a SpoolmanSync létrehozza a gyártót, a filamentet és a tekercset (a maradék súly az AMS becsléséből), és hozzárendeli a tálcához. A kézzel hozzárendelt tálcákhoz nem nyúl.
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={amsSyncing}
                        onClick={async () => {
                          setAmsSyncing(true);
                          try {
                            const res = await fetch('/api/spools/sync-ams', { method: 'POST' });
                            const data = await res.json();
                            if (!res.ok) throw new Error(data.error || 'Sikertelen AMS szinkron');
                            const errors = data.errors?.length ? `, ${data.errors.length} hiba` : '';
                            toast.success(`Új tekercsek: ${data.created} felvéve, ${data.assigned} hozzárendelve, ${data.alreadyAssigned} már megvolt${errors}`);
                          } catch (err) {
                            toast.error(err instanceof Error ? err.message : 'Sikertelen AMS szinkron');
                          } finally {
                            setAmsSyncing(false);
                          }
                        }}
                      >
                        {amsSyncing ? 'Felvétel…' : 'Új tekercsek felvétele most'}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="ml-2"
                        disabled={amsSyncing}
                        title="Az AMS-ben lévő RFID tekercsek maradék súlyát felülírja az AMS becslésével (kb. 1%-os pontosság)"
                        onClick={async () => {
                          setAmsSyncing(true);
                          try {
                            const res = await fetch('/api/spools/sync-ams-weights', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: '{}',
                            });
                            const data = await res.json();
                            if (!res.ok) throw new Error(data.error || 'Sikertelen súlyfrissítés');
                            const errors = data.errors?.length ? `, ${data.errors.length} hiba` : '';
                            toast.success(`Súlyok: ${data.updated?.length ?? 0} frissítve, ${data.unchanged} már egyezett, ${data.skipped} kihagyva${errors}`);
                          } catch (err) {
                            toast.error(err instanceof Error ? err.message : 'Sikertelen súlyfrissítés');
                          } finally {
                            setAmsSyncing(false);
                          }
                        }}
                      >
                        Súlyok frissítése az AMS-ből
                      </Button>
                    </div>
                  </div>

                  <div className="flex items-center space-x-3">
                    <Checkbox
                      id="never-auto-clear-tray"
                      checked={neverAutoClearTray}
                      onCheckedChange={async (checked) => {
                        const enabled = checked === true;
                        setNeverAutoClearTray(enabled);
                        try {
                          const res = await fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ type: 'never_auto_clear_tray', enabled }),
                          });
                          if (!res.ok) throw new Error();
                          toast.success(enabled ? 'A tálca-hozzárendelések nem törlődnek automatikusan' : 'A tálca-hozzárendelések automatikus törlése újra be');
                        } catch {
                          setNeverAutoClearTray(!enabled);
                          toast.error('Nem sikerült menteni a beállítást');
                        }
                      }}
                    />
                    <div>
                      <Label htmlFor="never-auto-clear-tray" className="text-sm font-medium cursor-pointer">
                        Tálca-hozzárendelések automatikus törlésének tiltása
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Bekapcsolva a SpoolmanSync nem veszi le a tekercset a tálcáról, ha a nyomtató rövid ideig üresnek jelzi. LAN-only módban hasznos, ahol az AMS néha tévesen üreset jelez.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center space-x-3">
                    <Checkbox
                      id="ignore-color-mismatch"
                      checked={ignoreColorMismatch}
                      onCheckedChange={async (checked) => {
                        const enabled = checked === true;
                        setIgnoreColorMismatch(enabled);
                        try {
                          const res = await fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ type: 'ignore_color_mismatch', enabled }),
                          });
                          if (!res.ok) throw new Error();
                          toast.success(enabled ? 'A figyelmeztetés csak az anyagot nézi' : 'A figyelmeztetés újra az anyagot és a színt is nézi');
                        } catch {
                          setIgnoreColorMismatch(!enabled);
                          toast.error('Nem sikerült menteni a beállítást');
                        }
                      }}
                    />
                    <div>
                      <Label htmlFor="ignore-color-mismatch" className="text-sm font-medium cursor-pointer">
                        Szín figyelmen kívül hagyása a rossz tekercs figyelmeztetésnél
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        A &quot;lehet, hogy rossz tekercs&quot; figyelmeztetés csak az anyagot hasonlítja össze. Akkor hasznos, ha az RFID olyan színt jelez, amilyen a tekercs valójában nem (gyakori a külsős Creality tageknél).
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center space-x-3">
                    <Checkbox
                      id="sync-spoolman-location"
                      checked={syncSpoolmanLocation}
                      onCheckedChange={async (checked) => {
                        const enabled = checked === true;
                        setSyncSpoolmanLocation(enabled);
                        try {
                          const res = await fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ type: 'sync_spoolman_location', enabled }),
                          });
                          if (!res.ok) throw new Error();
                          toast.success(enabled ? 'A tekercsek helye szinkronizálódik a Spoolmanbe' : 'Hely-szinkron kikapcsolva');
                        } catch {
                          setSyncSpoolmanLocation(!enabled);
                          toast.error('Nem sikerült menteni a beállítást');
                        }
                      }}
                    />
                    <div>
                      <Label htmlFor="sync-spoolman-location" className="text-sm font-medium cursor-pointer">
                        Tekercsek helyének szinkronizálása a Spoolmanbe
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Bekapcsolva a tálcához rendelés beírja a Spoolman hely mezőjét – valódi nyomtatónál alapból &quot;Nyomtató - AMS 1 Tray 3&quot;, virtuálisnál a nevét –, így a Spoolmanben látszik, hol van a tekercs. A levételkor törli, de a kézzel beírt helyet soha nem írja felül.
                      </p>
                    </div>
                  </div>

                  {/* Label detail — like the holding pen below, this only means
                      anything while location sync is on, since nothing writes a
                      location otherwise. */}
                  {syncSpoolmanLocation && (
                    <div className="ml-7 space-y-2">
                      <Label htmlFor="location-granularity" className="text-sm font-medium">
                        Hely részletessége
                      </Label>
                      <select
                        id="location-granularity"
                        value={locationGranularity}
                        onChange={(e) => saveLocationGranularity(e.target.value === 'ams' ? 'ams' : 'tray')}
                        className="flex h-10 w-full max-w-sm rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <option value="tray">Tálcánként (Nyomtató - AMS 1 Tray 3)</option>
                        <option value="ams">AMS egységenként (Nyomtató - AMS 1)</option>
                      </select>
                      <p className="text-xs text-muted-foreground">
                        Mennyire legyen pontos a hely. AMS egységenként az egy AMS-ben lévő tekercsek közös helyet kapnak. A külső tekercsekre és az AMS nélküli nyomtatókra nincs hatása. A váltás a már elhelyezett tekercseket is frissíti az áttekintés következő betöltésekor.
                      </p>
                    </div>
                  )}

                  {/* Holding pen — only meaningful while location sync is on, so
                      it's nested under the toggle and hidden when it's off. */}
                  {syncSpoolmanLocation && (
                    <div className="ml-7 space-y-2">
                      <Label htmlFor="unassigned-spool-location" className="text-sm font-medium">
                        Hely levett tekercsnél
                      </Label>
                      <Input
                        id="unassigned-spool-location"
                        value={unassignedSpoolLocation}
                        maxLength={64}
                        placeholder="Üresen hagyva a hely törlődik"
                        className="max-w-sm"
                        onChange={(e) => setUnassignedSpoolLocation(e.target.value)}
                        onBlur={saveUnassignedLocation}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                        }}
                      />
                      <p className="text-xs text-muted-foreground">
                        Opcionális. Ha egy tekercset leveszel a tálcáról, ez lesz a helye a mező törlése helyett, így a Spoolmanben is látszik. Üresen hagyva a hely törlődik. A kézzel beírt helyet soha nem írja felül.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}

          {/* Spool Filter Configuration */}
          {settings?.spoolman && (
            <>
              <Separator />
              <Card>
                <CardHeader>
                  <CardTitle>Tekercs szűrők</CardTitle>
                  <CardDescription>
                    Mely mezők jelenjenek meg szűrőként a tekercs tálcához rendelésekor.
                    A keresőmező ettől függetlenül minden mezőben keres.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {filterFields.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Szűrők betöltése...
                    </p>
                  ) : (
                    <div className="space-y-4">
                      {/* Built-in fields */}
                      <div>
                        <h4 className="text-sm font-medium mb-2 text-muted-foreground">Beépített mezők</h4>
                        <div className="space-y-3">
                          {filterFields.filter(f => f.builtIn).map((field) => (
                            <div key={field.key} className="flex items-center space-x-3">
                              <Checkbox
                                id={`filter-${field.key}`}
                                checked={enabledFilters.includes(field.key)}
                                onCheckedChange={() => toggleFilter(field.key)}
                                disabled={savingFilters}
                              />
                              <div className="flex-1">
                                <Label
                                  htmlFor={`filter-${field.key}`}
                                  className="text-sm font-medium cursor-pointer"
                                >
                                  {field.name}
                                </Label>
                                {field.values.length > 0 ? (
                                  <p className="text-xs text-muted-foreground">
                                    {field.values.length} érték: {field.values.slice(0, 3).join(', ')}{field.values.length > 3 ? '...' : ''}
                                  </p>
                                ) : (
                                  <p className="text-xs text-muted-foreground italic">
                                    Egyik tekercsen sincs kitöltve
                                  </p>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Extra fields (if any) */}
                      {filterFields.some(f => !f.builtIn) && (
                        <div>
                          <h4 className="text-sm font-medium mb-2 text-muted-foreground">Egyéni extra mezők</h4>
                          <div className="space-y-3">
                            {filterFields.filter(f => !f.builtIn).map((field) => (
                              <div key={field.key} className="flex items-center space-x-3">
                                <Checkbox
                                  id={`filter-${field.key}`}
                                  checked={enabledFilters.includes(field.key)}
                                  onCheckedChange={() => toggleFilter(field.key)}
                                  disabled={savingFilters}
                                />
                                <div className="flex-1">
                                  <Label
                                    htmlFor={`filter-${field.key}`}
                                    className="text-sm font-medium cursor-pointer"
                                  >
                                    {field.name}
                                  </Label>
                                  {field.values.length > 0 ? (
                                    <p className="text-xs text-muted-foreground">
                                      {field.values.length} érték: {field.values.slice(0, 3).join(', ')}{field.values.length > 3 ? '...' : ''}
                                    </p>
                                  ) : (
                                    <p className="text-xs text-muted-foreground italic">
                                      Egyik tekercsen sincs kitöltve
                                    </p>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {enabledFilters.length === 0 && (
                        <p className="text-xs text-muted-foreground mt-2">
                          Nincs bekapcsolt szűrő, csak a keresőmező jelenik meg.
                        </p>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}

          {/* Low Filament Alerts */}
          {settings?.spoolman && (
            <>
              <Separator />
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <CardTitle>Fogyó filament riasztás</CardTitle>
                    {activeAlerts.length > 0 && (
                      <Badge variant="destructive">{activeAlerts.length}</Badge>
                    )}
                  </div>
                  <CardDescription>
                    Értesítés, ha egy filament típusból az utolsó tekercs is fogyóban van.
                    Minden nyomtatás után ellenőrzi, és Home Assistant értesítésként küldi.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center space-x-3">
                    <Checkbox
                      id="alerts-enabled"
                      checked={alertConfig.enabled}
                      onCheckedChange={(checked) =>
                        setAlertConfig(prev => ({ ...prev, enabled: Boolean(checked) }))
                      }
                    />
                    <Label htmlFor="alerts-enabled" className="cursor-pointer">
                      Fogyó filament riasztás bekapcsolása
                    </Label>
                  </div>

                  {alertConfig.enabled && (
                    <div className="space-y-4 pl-6">
                      {/* Threshold type */}
                      <div className="space-y-2">
                        <Label className="text-sm font-medium">Küszöb típusa</Label>
                        <div className="space-y-2">
                          <div className="flex items-center space-x-2">
                            <input
                              type="radio"
                              id="threshold-percentage"
                              name="thresholdType"
                              value="percentage"
                              checked={alertConfig.thresholdType === 'percentage'}
                              onChange={() => setAlertConfig(prev => ({ ...prev, thresholdType: 'percentage' }))}
                              className="h-4 w-4"
                            />
                            <Label htmlFor="threshold-percentage" className="cursor-pointer text-sm">
                              Maradék százalékban
                            </Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <input
                              type="radio"
                              id="threshold-grams"
                              name="thresholdType"
                              value="grams"
                              checked={alertConfig.thresholdType === 'grams'}
                              onChange={() => setAlertConfig(prev => ({ ...prev, thresholdType: 'grams' }))}
                              className="h-4 w-4"
                            />
                            <Label htmlFor="threshold-grams" className="cursor-pointer text-sm">
                              Súly grammban
                            </Label>
                          </div>
                        </div>
                      </div>

                      {/* Threshold value */}
                      <div className="space-y-2">
                        <Label htmlFor="threshold-value" className="text-sm font-medium">
                          Riasztás ez alatt: {alertConfig.thresholdType === 'percentage' ? '(%)' : '(gramm)'}
                        </Label>
                        <Input
                          id="threshold-value"
                          type="number"
                          min="0"
                          max={alertConfig.thresholdType === 'percentage' ? 100 : undefined}
                          value={alertConfig.thresholdValue}
                          onChange={(e) =>
                            setAlertConfig(prev => ({ ...prev, thresholdValue: Number(e.target.value) }))
                          }
                          className="w-32"
                        />
                      </div>

                      {/* Grouping strategy */}
                      <div className="space-y-2">
                        <Label className="text-sm font-medium">Tekercsek csoportosítása</Label>
                        <div className="space-y-2">
                          <div className="flex items-start space-x-2">
                            <input
                              type="radio"
                              id="group-material"
                              name="groupingStrategy"
                              value="material"
                              checked={alertConfig.groupingStrategy === 'material'}
                              onChange={() => {
                                setAlertConfig(prev => ({ ...prev, groupingStrategy: 'material', monitoredGroups: undefined }));
                                fetchAvailableGroups('material');
                              }}
                              className="h-4 w-4 mt-0.5"
                            />
                            <div>
                              <Label htmlFor="group-material" className="cursor-pointer text-sm">
                                Anyag
                              </Label>
                              <p className="text-xs text-muted-foreground">
                                Riasztás, ha az összes PLA, az összes PETG stb. tekercs fogyóban van.
                              </p>
                            </div>
                          </div>
                          <div className="flex items-start space-x-2">
                            <input
                              type="radio"
                              id="group-material-color"
                              name="groupingStrategy"
                              value="material_name"
                              checked={alertConfig.groupingStrategy === 'material_name'}
                              onChange={() => {
                                setAlertConfig(prev => ({ ...prev, groupingStrategy: 'material_name', monitoredGroups: undefined }));
                                fetchAvailableGroups('material_name');
                              }}
                              className="h-4 w-4 mt-0.5"
                            />
                            <div>
                              <Label htmlFor="group-material-color" className="cursor-pointer text-sm">
                                Anyag + név
                              </Label>
                              <p className="text-xs text-muted-foreground">
                                Riasztás termékenként (pl. az összes HF Black PETG, az összes Matte White PLA tekercs).
                              </p>
                            </div>
                          </div>
                          <div className="flex items-start space-x-2">
                            <input
                              type="radio"
                              id="group-material-vendor-name"
                              name="groupingStrategy"
                              value="material_name_vendor"
                              checked={alertConfig.groupingStrategy === 'material_name_vendor'}
                              onChange={() => {
                                setAlertConfig(prev => ({ ...prev, groupingStrategy: 'material_name_vendor', monitoredGroups: undefined }));
                                fetchAvailableGroups('material_name_vendor');
                              }}
                              className="h-4 w-4 mt-0.5"
                            />
                            <div>
                              <Label htmlFor="group-material-vendor-name" className="cursor-pointer text-sm">
                                Anyag + név + gyártó
                              </Label>
                              <p className="text-xs text-muted-foreground">
                                Mint az anyag + név, de a gyártókat is megkülönbözteti (pl. Bambu Lab HF Black PETG és Polymaker PolyLite Black PETG).
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Monitored groups */}
                      <div className="space-y-2">
                        <Label className="text-sm font-medium">Figyelt csoportok</Label>
                        <div className="space-y-2">
                          <div className="flex items-center space-x-2">
                            <input
                              type="radio"
                              id="monitor-all"
                              name="monitorMode"
                              checked={alertConfig.monitoredGroups === undefined}
                              onChange={() => setAlertConfig(prev => ({ ...prev, monitoredGroups: undefined }))}
                              className="h-4 w-4"
                            />
                            <Label htmlFor="monitor-all" className="cursor-pointer text-sm">
                              Minden csoport
                            </Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <input
                              type="radio"
                              id="monitor-selected"
                              name="monitorMode"
                              checked={alertConfig.monitoredGroups !== undefined}
                              onChange={() => setAlertConfig(prev => ({ ...prev, monitoredGroups: [] }))}
                              className="h-4 w-4"
                            />
                            <Label htmlFor="monitor-selected" className="cursor-pointer text-sm">
                              Csak a kiválasztottak
                            </Label>
                          </div>
                        </div>

                        {alertConfig.monitoredGroups !== undefined && (
                          <div className="ml-6 space-y-2 pt-1">
                            {availableGroups.length === 0 ? (
                              <p className="text-xs text-muted-foreground italic">Nincs tekercscsoport.</p>
                            ) : (
                              availableGroups.map((group) => (
                                <div key={group.groupKey} className="flex items-center space-x-2">
                                  <Checkbox
                                    id={`group-${group.groupKey}`}
                                    checked={alertConfig.monitoredGroups?.includes(group.groupKey) ?? false}
                                    onCheckedChange={(checked) => {
                                      setAlertConfig(prev => {
                                        const current = prev.monitoredGroups || [];
                                        const updated = checked
                                          ? [...current, group.groupKey]
                                          : current.filter(k => k !== group.groupKey);
                                        return { ...prev, monitoredGroups: updated };
                                      });
                                    }}
                                  />
                                  <div className="flex items-center gap-2">
                                    {(alertConfig.groupingStrategy === 'material_name' || alertConfig.groupingStrategy === 'material_name_vendor') && group.color_hex && (
                                      <span
                                        className="inline-block w-3 h-3 rounded-full border border-border shrink-0"
                                        style={{ backgroundColor: `#${group.color_hex.replace('#', '')}` }}
                                      />
                                    )}
                                    <Label
                                      htmlFor={`group-${group.groupKey}`}
                                      className="cursor-pointer text-sm"
                                    >
                                      {group.groupLabel}
                                    </Label>
                                    <span className="text-xs text-muted-foreground">
                                      ({group.spoolCount} tekercs)
                                    </span>
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>

                      <Button
                        onClick={saveAlertSettings}
                        disabled={savingAlerts}
                      >
                        {savingAlerts ? 'Mentés...' : 'Riasztási beállítások mentése'}
                      </Button>
                    </div>
                  )}

                  {!alertConfig.enabled && (
                    <Button
                      onClick={saveAlertSettings}
                      disabled={savingAlerts}
                      variant="outline"
                      size="sm"
                    >
                      {savingAlerts ? 'Mentés...' : 'Mentés'}
                    </Button>
                  )}
                </CardContent>
              </Card>
            </>
          )}

          {/* QR Code Base URL */}
          <Card>
            <CardHeader>
              <CardTitle>QR Code / NFC URL</CardTitle>
              <CardDescription>
                A QR-címkékben és NFC tagekben használt alap cím felülírása.
                Üresen hagyva a böngésző aktuális címét használja.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="qrBaseUrl">Alap cím</Label>
                <div className="flex gap-2">
                  <Input
                    id="qrBaseUrl"
                    value={qrBaseUrl}
                    onChange={(e) => setQrBaseUrl(e.target.value)}
                    placeholder="pl. http://192.168.1.100:3000"
                  />
                  <Button
                    onClick={async () => {
                      setSavingQrUrl(true);
                      try {
                        const res = await fetch('/api/settings', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ type: 'qr_base_url', url: qrBaseUrl }),
                        });
                        if (!res.ok) throw new Error();
                        toast.success(qrBaseUrl.trim() ? 'QR alap cím mentve' : 'QR alap cím törölve');
                      } catch {
                        toast.error('Nem sikerült menteni a QR alap címet');
                      } finally {
                        setSavingQrUrl(false);
                      }
                    }}
                    disabled={savingQrUrl}
                  >
                    {savingQrUrl ? 'Mentés...' : 'Mentés'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Akkor hasznos, ha a SpoolmanSync-et reverse proxyn vagy saját domainen éred el.
                  A QR-kódok erre a címre mutatnak a böngésző címsora helyett.
                </p>
              </div>
            </CardContent>
          </Card>

        </div>

        {/* Add Printer Dialog */}
        <AddPrinterDialog
          open={addPrinterOpen}
          onOpenChange={setAddPrinterOpen}
          onSuccess={fetchPrinters}
        />
      </main>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-background">
        <Nav />
        <main className="w-full max-w-2xl mx-auto py-6 px-3 sm:px-4 md:px-6">
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        </main>
      </div>
    }>
      <SettingsContent />
    </Suspense>
  );
}
