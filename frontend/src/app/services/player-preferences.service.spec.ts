import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerPreferencesService } from './player-preferences.service';

/**
 * What the player restores from storage, and what it refuses to.
 *
 * <h2>Why the clamping is the point</h2>
 * Everything read here is applied straight to a media element. `volume = NaN` throws, and a stored
 * playbackRate of 16 is both unplayable and unreachable from the speed menu — leaving a viewer with
 * a broken player and no way back except clearing site data. The stored values come from a previous
 * version of this code, a half-written write, or anything else on the origin, so none of them can
 * be trusted to be in range just because this code put them there.
 */
describe('PlayerPreferencesService', () => {

  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
      clear: () => { store = {}; },
    });
  });

  const KEY = 'vms.player-prefs.v1';

  it('returns defaults when nothing has been stored', () => {
    const prefs = new PlayerPreferencesService().load();

    expect(prefs).toEqual({ volume: 1, muted: false, speed: 1, captions: false });
  });

  it('round-trips a saved preference', () => {
    const service = new PlayerPreferencesService();

    service.save({ volume: 0.4, speed: 1.5 });

    expect(service.load().volume).toBe(0.4);
    expect(service.load().speed).toBe(1.5);
  });

  it('merges a partial save rather than replacing the record', () => {
    const service = new PlayerPreferencesService();
    service.save({ volume: 0.3, captions: true });

    service.save({ speed: 2 });

    // Muting should not forget that captions were on — each control writes only its own field.
    expect(service.load()).toEqual({ volume: 0.3, muted: false, speed: 2, captions: true });
  });

  it('rejects a stored NaN volume rather than passing it to the media element', () => {
    store[KEY] = JSON.stringify({ volume: NaN });

    // JSON.stringify turns NaN into null, which is exactly the shape a bad write leaves behind.
    expect(new PlayerPreferencesService().load().volume).toBe(1);
  });

  it('rejects a volume outside 0-1', () => {
    store[KEY] = JSON.stringify({ volume: 4 });
    expect(new PlayerPreferencesService().load().volume).toBe(1);

    store[KEY] = JSON.stringify({ volume: -1 });
    expect(new PlayerPreferencesService().load().volume).toBe(1);
  });

  it('rejects a speed the menu cannot reach', () => {
    // 16 is playable by the element but absent from SPEEDS, so nothing in the UI could set it back.
    store[KEY] = JSON.stringify({ speed: 16 });

    expect(new PlayerPreferencesService().load().speed).toBe(1);
  });

  it('rejects non-boolean flags', () => {
    store[KEY] = JSON.stringify({ muted: 'yes', captions: 1 });

    const prefs = new PlayerPreferencesService().load();
    expect(prefs.muted).toBe(false);
    expect(prefs.captions).toBe(false);
  });

  it('survives corrupt JSON', () => {
    store[KEY] = '{not json';

    expect(new PlayerPreferencesService().load()).toEqual(
      { volume: 1, muted: false, speed: 1, captions: false });
  });

  it('survives localStorage throwing, as it does in some private modes', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('denied'); },
      setItem: () => { throw new DOMException('denied'); },
    });
    const service = new PlayerPreferencesService();

    // A player that fails to start because it could not read a volume setting would be a far worse
    // bug than one that starts at full volume.
    expect(() => service.save({ volume: 0.5 })).not.toThrow();
    expect(service.load()).toEqual({ volume: 1, muted: false, speed: 1, captions: false });
  });
});
