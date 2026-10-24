import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpoolmanClient, normalizeTag, type Filament, type Spool, type Vendor } from './api/spoolman';
import {
  decideWeightSync,
  densityForMaterial,
  ensureSpoolForTray,
  findMatchingFilament,
  isAutoCreateEnabled,
  normalizeColorHex,
  parseBambuTray,
  stripVendorPrefix,
} from './auto-create-spool';

// Real attributes of an H2C AMS tray as ha-bambulab reports them.
const H2C_TRAY = {
  slot: 1,
  active: false,
  color: '#000000FF',
  cols: ['#000000FF'],
  empty: false,
  filament_id: 'GFA00',
  tray_weight: '1000',
  name: 'Bambu PLA Basic',
  nozzle_temp_min: '190',
  nozzle_temp_max: '230',
  bed_temp: '0',
  remain: 12,
  remain_enabled: true,
  tag_uid: 'BD6E803000000100',
  tray_uuid: 'A35C6CDF3852467AB08AA2AADA016C93',
  type: 'PLA',
};

describe('parseBambuTray', () => {
  it('reads a Bambu RFID tray', () => {
    const info = parseBambuTray(H2C_TRAY);
    expect(info).toMatchObject({
      trayUuid: 'A35C6CDF3852467AB08AA2AADA016C93',
      filamentName: 'PLA Basic',
      material: 'PLA',
      colorHex: '000000',
      trayWeight: 1000,
      remainingWeight: 120,
      remainFromAms: true,
      extruderTemp: 210,
      bambuFilamentId: 'GFA00',
    });
    expect(info?.multiColorHexes).toBeUndefined();
    expect(info?.bedTemp).toBeUndefined();
  });

  it('falls back to a full spool when the AMS has no remain estimate', () => {
    const info = parseBambuTray({ ...H2C_TRAY, remain: -1, remain_enabled: false });
    expect(info?.remainingWeight).toBe(1000);
    expect(info?.remainFromAms).toBe(false);
  });

  it('uses the reported spool size', () => {
    const info = parseBambuTray({ ...H2C_TRAY, tray_weight: '500', remain: 50 });
    expect(info?.trayWeight).toBe(500);
    expect(info?.remainingWeight).toBe(250);
  });

  it('reports multi-color spools', () => {
    const info = parseBambuTray({ ...H2C_TRAY, cols: ['#FF0000FF', '#00FF00FF'], color: '#FF0000FF' });
    expect(info?.multiColorHexes).toBe('ff0000,00ff00');
  });

  it('rejects trays without a usable RFID serial', () => {
    expect(parseBambuTray({ ...H2C_TRAY, tray_uuid: '00000000000000000000000000000000' })).toBeNull();
    expect(parseBambuTray({ ...H2C_TRAY, tray_uuid: '' })).toBeNull();
    expect(parseBambuTray({ ...H2C_TRAY, empty: true })).toBeNull();
    expect(parseBambuTray({ ...H2C_TRAY, name: 'Empty' })).toBeNull();
    expect(parseBambuTray({ ...H2C_TRAY, name: '?' })).toBeNull();
    expect(parseBambuTray(null)).toBeNull();
  });
});

describe('small helpers', () => {
  it('normalizes colors', () => {
    expect(normalizeColorHex('#9D432CFF')).toBe('9d432c');
    expect(normalizeColorHex('9d432c')).toBe('9d432c');
    expect(normalizeColorHex('red')).toBeUndefined();
  });

  it('strips the vendor prefix', () => {
    expect(stripVendorPrefix('Bambu PLA Basic')).toBe('PLA Basic');
    expect(stripVendorPrefix('Bambu Lab PETG HF')).toBe('PETG HF');
    expect(stripVendorPrefix('Generic PLA')).toBe('Generic PLA');
  });

  it('picks densities for material variants', () => {
    expect(densityForMaterial('PETG')).toBe(1.27);
    expect(densityForMaterial('PLA-CF')).toBe(1.24);
    expect(densityForMaterial('PETG HF')).toBe(1.27);
    expect(densityForMaterial('WEIRD')).toBe(1.24);
  });

  it('defaults auto-create to on', () => {
    expect(isAutoCreateEnabled(undefined)).toBe(true);
    expect(isAutoCreateEnabled(null)).toBe(true);
    expect(isAutoCreateEnabled('true')).toBe(true);
    expect(isAutoCreateEnabled('false')).toBe(false);
  });
});

describe('findMatchingFilament', () => {
  const vendor: Vendor = { id: 3, name: 'Bambu Lab', registered: '' };
  const fil = (id: number, name: string, color: string, vendorId = 3, material = 'PLA'): Filament => ({
    id, name, material, color_hex: color, multi_color_hexes: null, multi_color_direction: null,
    density: 1.24, diameter: 1.75, vendor: { ...vendor, id: vendorId },
  });
  const info = parseBambuTray(H2C_TRAY)!;

  it('reuses an exact match', () => {
    expect(findMatchingFilament([fil(1, 'PLA Basic', '000000')], 3, info)?.id).toBe(1);
  });

  it('reuses a SpoolmanDB-style name containing ours', () => {
    expect(findMatchingFilament([fil(2, 'PLA Basic Black', '000000')], 3, info)?.id).toBe(2);
  });

  it('does not match another color, vendor or material', () => {
    expect(findMatchingFilament([
      fil(1, 'PLA Basic', 'ffffff'),
      fil(2, 'PLA Basic', '000000', 99),
      fil(3, 'PLA Basic', '000000', 3, 'PETG'),
    ], 3, info)).toBeUndefined();
  });
});

describe('decideWeightSync', () => {
  const info = parseBambuTray(H2C_TRAY)!; // 12% of 1000 g → 120 g
  const spool = (remaining: number, tag?: string) =>
    ({ remaining_weight: remaining, extra: tag === undefined ? {} : { tag: JSON.stringify(tag) } }) as unknown as Spool;

  it('updates the same spool to the AMS estimate', () => {
    expect(decideWeightSync(spool(1000, 'a35c6cdf3852467ab08aa2aada016c93'), info, normalizeTag))
      .toEqual({ action: 'update', remainingWeight: 120, previous: 1000 });
  });

  it('updates a hand-assigned spool without a stored serial', () => {
    expect(decideWeightSync(spool(800), info, normalizeTag).action).toBe('update');
  });

  it('never touches a different physical spool', () => {
    expect(decideWeightSync(spool(1000, 'FFFF0000FFFF0000FFFF0000FFFF0000'), info, normalizeTag))
      .toEqual({ action: 'skip', reason: 'different_spool' });
  });

  it('skips when the AMS has no estimate or nothing changed', () => {
    const noEstimate = parseBambuTray({ ...H2C_TRAY, remain: -1, remain_enabled: false })!;
    expect(decideWeightSync(spool(500), noEstimate, normalizeTag)).toEqual({ action: 'skip', reason: 'no_ams_estimate' });
    expect(decideWeightSync(spool(120.4), info, normalizeTag)).toEqual({ action: 'skip', reason: 'unchanged' });
  });
});

describe('ensureSpoolForTray', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubSpoolman(state: { spools: Spool[]; vendors: Vendor[]; filaments: Filament[] }) {
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit = {}) => {
      const method = (opts.method || 'GET').toUpperCase();
      const path = new URL(url).pathname.replace('/api/v1', '');
      const json = (data: unknown) => ({ ok: true, json: async () => data }) as unknown as Response;
      if (method === 'GET' && path === '/spool') return json(state.spools);
      if (method === 'GET' && path === '/vendor') return json(state.vendors);
      if (method === 'GET' && path === '/filament') return json(state.filaments);
      if (method === 'POST') {
        const body = JSON.parse(opts.body as string);
        posts.push({ path, body });
        if (path === '/vendor') return json({ id: 10, registered: '', ...body });
        if (path === '/filament') return json({ id: 20, vendor: { id: body.vendor_id }, ...body });
        if (path === '/spool') return json({ id: 30, filament: { id: body.filament_id, name: 'PLA Basic' }, ...body });
      }
      throw new Error(`unexpected ${method} ${path}`);
    }));
    return posts;
  }

  it('creates vendor, filament and spool with serial and AMS weight', async () => {
    const posts = stubSpoolman({ spools: [], vendors: [], filaments: [] });
    const result = await ensureSpoolForTray(new SpoolmanClient('http://spoolman:8000'), parseBambuTray(H2C_TRAY)!);

    expect(result).toMatchObject({ created: true, filamentCreated: true, vendorCreated: true });
    expect(posts.map(p => p.path)).toEqual(['/vendor', '/filament', '/spool']);
    expect(posts[1].body).toMatchObject({
      name: 'PLA Basic', vendor_id: 10, material: 'PLA', color_hex: '000000',
      density: 1.24, diameter: 1.75, weight: 1000, settings_extruder_temp: 210,
    });
    expect(posts[2].body).toMatchObject({
      filament_id: 20,
      initial_weight: 1000,
      remaining_weight: 120,
      extra: { tag: JSON.stringify('A35C6CDF3852467AB08AA2AADA016C93') },
    });
  });

  it('reuses the existing vendor and filament', async () => {
    const posts = stubSpoolman({
      spools: [],
      vendors: [{ id: 3, name: 'Bambu Lab', registered: '' }],
      filaments: [{
        id: 7, name: 'PLA Basic', material: 'PLA', color_hex: '000000', multi_color_hexes: null,
        multi_color_direction: null, density: 1.24, diameter: 1.75, vendor: { id: 3, name: 'Bambu Lab', registered: '' },
      }],
    });
    const result = await ensureSpoolForTray(new SpoolmanClient('http://spoolman:8000'), parseBambuTray(H2C_TRAY)!);

    expect(result).toMatchObject({ created: true, filamentCreated: false, vendorCreated: false });
    expect(posts.map(p => p.path)).toEqual(['/spool']);
    expect(posts[0].body.filament_id).toBe(7);
  });

  it('creates nothing when a spool already carries the serial', async () => {
    const existing = {
      id: 5, filament: { id: 7, name: 'PLA Basic' },
      extra: { tag: JSON.stringify('a35c6cdf3852467ab08aa2aada016c93') },
    } as unknown as Spool;
    const posts = stubSpoolman({ spools: [existing], vendors: [], filaments: [] });
    const result = await ensureSpoolForTray(new SpoolmanClient('http://spoolman:8000'), parseBambuTray(H2C_TRAY)!);

    expect(result.created).toBe(false);
    expect(result.spool.id).toBe(5);
    expect(posts).toHaveLength(0);
  });
});
