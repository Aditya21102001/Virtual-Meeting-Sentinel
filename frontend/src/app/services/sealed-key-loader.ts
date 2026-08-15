import Hls from 'hls.js';
import { environment } from '../../environments/environment';

/**
 * Routes every request hls.js makes through POST, and agrees the decryption key by ECDH.
 *
 * <h2>Why a custom loader can do this at all</h2>
 * The browser issues some media requests itself — {@code <video src>}, {@code <img>} posters,
 * Safari's native HLS — and those can only ever be GET. But playlists, segments and keys are
 * fetched by <b>hls.js</b>, through a loader that is pluggable. Those are ours, so their method is
 * ours to choose.
 *
 * <p>POST keeps the playback ticket and the requested path out of URLs entirely: out of browser
 * history, out of server access logs, out of {@code Referer} headers, out of any CDN cache key. The
 * GET routes remain for the paths the browser owns.
 *
 * <h2>How the key is agreed</h2>
 * Both sides publish a public key and neither transmits a secret:
 *
 * <pre>
 *   server: ECDH(server private, client public)  ─┬─►  the same 32 bytes
 *   client: ECDH(client private, server public)  ─┘
 * </pre>
 *
 * That derived value (hashed) decrypts the AES content key. Only two public keys cross the network,
 * in opposite directions, and an observer holding both cannot derive the secret.
 *
 * <p>The client keypair is generated with {@code extractable: false}, so the private half is held
 * by the browser and not by JavaScript. Script on the page — including anything injected by XSS —
 * can ask the browser to derive, but cannot read the key or exfiltrate it. Verified: with that flag
 * {@code exportKey('spki')} still works while {@code exportKey('pkcs8')} throws.
 *
 * <h2>What this cannot protect</h2>
 * hls.js needs the plaintext AES key to decrypt segments, so it exists in this tab's memory by
 * necessity and devtools can read it. That is the DRM problem; no key exchange solves it.
 *
 * <h2>Failure behaviour</h2>
 * Anything unexpected — no WebCrypto, an older server, a request shape not recognised — falls back
 * to the default loader and the existing GET routes. A misbehaving exchange degrades to the
 * previous behaviour rather than to a video that will not play.
 */
/** Logged once per session, not per segment — a failing transport must not flood the console. */
let warnedAboutFallback = false;

export function createMediaLoader(): typeof Hls.DefaultConfig.loader {
  const DefaultLoader = Hls.DefaultConfig.loader;

  return class PostMediaLoader extends DefaultLoader {
    override load(context: any, config: any, callbacks: any): void {
      const parsed = parseMediaUrl(String(context?.url ?? ''));
      if (!parsed || typeof fetch !== 'function') {
        super.load(context, config, callbacks);
        return;
      }
      void this.postLoad(parsed, context, config, callbacks);
    }

    private async postLoad(parsed: MediaTarget, context: any, config: any,
                           callbacks: any): Promise<void> {
      const started = performance.now();
      try {
        const body = parsed.kind === 'key'
          ? await fetchContentKey(parsed)
          : await fetchMedia(parsed);

        // hls.js asks for text for playlists and an ArrayBuffer for everything else. Honouring
        // responseType matters: handing a manifest back as bytes makes the parser fail with an
        // error that names neither this loader nor the request.
        const data = context.responseType === 'text'
          ? new TextDecoder().decode(body)
          : body;

        // hls.js does not treat stats as a plain bag: after onSuccess it writes into
        // stats.parsing.start and stats.buffering.start directly. Handing it a bare {} threw
        // "Cannot set properties of undefined (setting 'start')" on every request, so the POST
        // transport failed instantly and silently fell back to GET. Reuse the object hls.js
        // supplied when there is one; otherwise build the full shape it expects.
        const now = performance.now();
        const stats = context.stats ?? {
          aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
          loading: { start: 0, first: 0, end: 0 },
          parsing: { start: 0, end: 0 },
          buffering: { start: 0, first: 0, end: 0 },
        };
        stats.loading.start = started;
        stats.loading.first = now;
        stats.loading.end = now;
        stats.loaded = stats.total = body.byteLength;

        callbacks.onSuccess({ url: context.url, data }, stats, context, null);
      } catch (error) {
        // FALL BACK TO THE GET ROUTES, and this is a deployment safety net rather than a nicety.
        //
        // The frontend and the backend deploy independently. Ship this loader before the server
        // that answers /media and every POST returns 404 — which, without this, would break video
        // playback everywhere until the backend caught up. Falling back to super.load() means the
        // worst case is "the POST path is not available yet", not "recordings do not play".
        //
        // It also covers a proxy that rejects POST for media, and any request shape the server
        // does not recognise. Logged once so the cause is visible rather than silent.
        if (!warnedAboutFallback) {
          warnedAboutFallback = true;
          console.info('[media] POST transport unavailable, using the GET routes:', String(error));
        }
        super.load(context, config, callbacks);
      }
    }
  };
}

// ---------------------------------------------------------------- the exchange ----

/** Cached per tab: one keypair and one agreed secret serve every key request in the session. */
let clientKeys: Promise<CryptoKeyPair> | null = null;
let serverPublicKey: Promise<CryptoKey> | null = null;

async function fetchContentKey(target: MediaTarget): Promise<ArrayBuffer> {
  const pair = await ensureClientKeys();
  const theirs = await ensureServerKey();

  const publicKey = base64(await crypto.subtle.exportKey('spki', pair.publicKey));

  const sealed = await postFor(`${environment.apiBase}/api/videos/content-key`, {
    id: target.id,
    rendition: target.rendition,
    ticket: target.ticket,
    publicKey,
  });

  // Both sides reach the same 32 bytes without either transmitting them.
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: theirs }, pair.privateKey, 256);

  // Must match the server byte for byte: SHA-256 over (shared || label).
  const label = new TextEncoder().encode('agm-video-content-key');
  const material = new Uint8Array(shared.byteLength + label.length);
  material.set(new Uint8Array(shared), 0);
  material.set(label, shared.byteLength);
  const aesKey = await crypto.subtle.importKey(
    'raw', await crypto.subtle.digest('SHA-256', material), 'AES-GCM', false, ['decrypt']);

  // nonce(12) || ciphertext || tag(16)
  const blob = new Uint8Array(sealed);
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: blob.slice(0, 12) }, aesKey, blob.slice(12));
}

function ensureClientKeys(): Promise<CryptoKeyPair> {
  if (!clientKeys) {
    clientKeys = crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      // Non-extractable: the private half is the browser's, not JavaScript's. The public half is
      // always exportable regardless, which is what lets us publish it.
      false,
      ['deriveBits'],
    ) as Promise<CryptoKeyPair>;
  }
  return clientKeys;
}

function ensureServerKey(): Promise<CryptoKey> {
  if (!serverPublicKey) {
    serverPublicKey = (async () => {
      const response = await fetch(`${environment.apiBase}/api/videos/key-exchange-parameters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const { publicKey } = await response.json();
      return crypto.subtle.importKey(
        'spki', fromBase64(publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    })();
  }
  return serverPublicKey;
}

async function fetchMedia(target: MediaTarget): Promise<ArrayBuffer> {
  return postFor(`${environment.apiBase}/api/videos/media`, {
    id: target.id,
    kind: target.kind,
    rendition: target.rendition,
    filename: target.filename,
    ticket: target.ticket,
  });
}

async function postFor(url: string, body: unknown): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.arrayBuffer();
}

// ------------------------------------------------------------------ url parsing ----

interface MediaTarget {
  kind: 'master' | 'playlist' | 'segment' | 'key';
  id: string;
  rendition: string;
  filename: string;
  ticket: string;
}

/**
 * Recognise the URLs hls.js was going to GET, so they can be sent as POST instead.
 *
 * <p>Returns null for anything unrecognised, which sends the request down the default path — the
 * loader is then exactly the stock one.
 */
function parseMediaUrl(raw: string): MediaTarget | null {
  let url: URL;
  try {
    url = new URL(raw, location.origin);
  } catch {
    return null;
  }
  const ticket = url.searchParams.get('t') ?? '';
  const path = url.pathname;

  const key = /\/api\/videos\/([^/]+)\/r\/([^/]+)\/key$/.exec(path);
  if (key) return { kind: 'key', id: key[1], rendition: key[2], filename: '', ticket };

  const segment = /\/api\/videos\/([^/]+)\/r\/([^/]+)\/(seg_\d+\.ts)$/.exec(path);
  if (segment) {
    return { kind: 'segment', id: segment[1], rendition: segment[2], filename: segment[3], ticket };
  }

  const playlist = /\/api\/videos\/([^/]+)\/r\/([^/]+)\/index\.m3u8$/.exec(path);
  if (playlist) {
    return { kind: 'playlist', id: playlist[1], rendition: playlist[2], filename: '', ticket };
  }

  const master = /\/api\/videos\/([^/]+)\/master\.m3u8$/.exec(path);
  if (master) return { kind: 'master', id: master[1], rendition: '', filename: '', ticket };

  return null;
}

function base64(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}
