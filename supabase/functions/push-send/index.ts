/* ===========================================================================
   push-send — the only part of the alert system that is not SQL

   Postgres decides who is told and what they are told. This takes the rows it
   left in push_queue and puts them on the wire, which is the one thing the
   database cannot do: a web push has to be encrypted to a key the phone
   generated (RFC 8291) and signed with a key of ours (RFC 8292), and pgcrypto
   has no P-256.

   It is written against Web Crypto rather than against a push library on
   purpose. The whole protocol is about eighty lines, the site has no build
   step anywhere else, and a dependency that stops working under a new Deno is
   a dependency that stops the alerts on an auction night.

   It has no public door. Every request must carry the shared secret, which
   lives in the vault on the database side and in this function's secrets here;
   anything else is refused before a single row is read.
   =========================================================================== */

const SHARED_SECRET = Deno.env.get("PUSH_SHARED_SECRET") ?? "";
const VAPID_PUBLIC  = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:nazm.anwr@gmail.com";

// Supabase sets these two itself. The service key is what lets this read the
// queue at all: both tables have row level security on and no policies.
const DB_URL      = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

/* --- Bytes ---------------------------------------------------------------- */

const utf8 = new TextEncoder();

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") +
                 "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function join(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/* --- Signing the request (VAPID, RFC 8292) ---------------------------------
   Proves to the push service that the alert came from us. The signature is
   over the endpoint's origin and an expiry, so one token cannot be replayed at
   a different service, and none of them last more than half a day.

   Imported once and kept: signing is cheap, importing is not, and a lot
   opening means a few hundred of these in a row.
-------------------------------------------------------------------------- */

let signingKey: Promise<CryptoKey> | null = null;

function vapidKey(): Promise<CryptoKey> {
  if (!signingKey) {
    const raw = fromBase64Url(VAPID_PUBLIC);   // 0x04 || x || y
    signingKey = crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: toBase64Url(raw.slice(1, 33)),
        y: toBase64Url(raw.slice(33, 65)),
        d: VAPID_PRIVATE,
        ext: true
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
  }
  return signingKey;
}

async function authorization(endpoint: string): Promise<string> {
  const header = toBase64Url(utf8.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = toBase64Url(utf8.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: VAPID_SUBJECT
  })));

  const signed = header + "." + claims;
  // Web Crypto returns ES256 as the raw r||s pair, which is exactly what a JWT
  // wants — no DER unwrapping needed.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await vapidKey(),
    utf8.encode(signed)
  );

  return "vapid t=" + signed + "." + toBase64Url(new Uint8Array(signature)) +
         ", k=" + VAPID_PUBLIC;
}

/* --- Encrypting the body (aes128gcm, RFC 8291) -----------------------------
   The push service relays the alert but must not be able to read it, so the
   text is encrypted to the browser's own key before it leaves here. Nobody in
   between — not Google, not Apple — sees what the artwork is or what it sold
   for.
-------------------------------------------------------------------------- */

async function hkdf(
  salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8
  );
  return new Uint8Array(bits);
}

async function encrypt(
  plaintext: Uint8Array, p256dh: string, authSecret: string
): Promise<Uint8Array> {
  const uaPublic = fromBase64Url(p256dh);
  const uaAuth   = fromBase64Url(authSecret);

  // A fresh keypair for every message: the shared secret below must never be
  // reused across two alerts to the same phone.
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  ) as CryptoKeyPair;

  const asPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", ephemeral.publicKey)
  );

  const uaKey = await crypto.subtle.importKey(
    "raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []
  );

  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaKey }, ephemeral.privateKey, 256
  ));

  // Mix in both public keys, so a secret derived for this pair cannot be made
  // to look like one derived for another.
  const keyInfo = join(utf8.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(uaAuth, shared, keyInfo, 32);

  const salt  = crypto.getRandomValues(new Uint8Array(16));
  const cek   = await hkdf(salt, ikm, utf8.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8.encode("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    aes,
    join(plaintext, new Uint8Array([2]))   // 0x02: the last (and only) record
  ));

  // salt | record size | length of the key | the key | the ciphertext
  const head = new Uint8Array(16 + 4 + 1 + 65);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = 65;
  head.set(asPublic, 21);

  return join(head, ciphertext);
}

/* --- Talking to the database ----------------------------------------------- */

type Claimed = {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  payload: Record<string, unknown>;
};

function rpc(name: string, args: unknown): Promise<Response> {
  return fetch(DB_URL + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY
    },
    body: JSON.stringify(args)
  });
}

/* --- One alert -------------------------------------------------------------- */

type Result = { id: number; status: string; detail: string | null; gone: boolean };

async function deliver(row: Claimed): Promise<Result> {
  try {
    const body = await encrypt(
      utf8.encode(JSON.stringify(row.payload)), row.p256dh, row.auth
    );

    const res = await fetch(row.endpoint, {
      method: "POST",
      headers: {
        Authorization: await authorization(row.endpoint),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        // Kept for a day if the phone is off. An auction runs longer than that,
        // and an alert older than a day is worse than none — the price in it
        // will have moved.
        TTL: "86400",
        Urgency: "high"
      },
      body
    });

    if (res.status === 404 || res.status === 410) {
      // That browser is gone for good: data cleared, app removed, permission
      // withdrawn. push_settle deletes it rather than retrying forever.
      return { id: row.id, status: "failed", detail: "subscription gone", gone: true };
    }

    if (res.ok) return { id: row.id, status: "sent", detail: null, gone: false };

    const text = await res.text().catch(() => "");
    return {
      id: row.id,
      status: "failed",
      detail: res.status + " " + text.slice(0, 300),
      gone: false
    };
  } catch (err) {
    return {
      id: row.id,
      status: "failed",
      detail: String((err as Error)?.message ?? err).slice(0, 300),
      gone: false
    };
  }
}

/* --- The door --------------------------------------------------------------- */

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Not here.", { status: 405 });
  }

  // Before anything is read. The queue holds addresses that make strangers'
  // phones buzz, and this header is the only thing standing in front of it.
  const offered = req.headers.get("x-push-secret") ?? "";
  if (!SHARED_SECRET || offered !== SHARED_SECRET) {
    return new Response("No.", { status: 401 });
  }

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return new Response(
      JSON.stringify({ error: "The VAPID keys are not set on this function." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const claimed = await rpc("push_claim", { p_limit: 400 });
  if (!claimed.ok) {
    const detail = await claimed.text().catch(() => "");
    return new Response(
      JSON.stringify({ error: "could not claim", detail: detail.slice(0, 300) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const rows = await claimed.json() as Claimed[];
  if (!rows.length) {
    return new Response(JSON.stringify({ sent: 0, failed: 0 }),
      { headers: { "Content-Type": "application/json" } });
  }

  // In slices rather than all at once: a lot opening means every phone that
  // ever asked, and several hundred sockets opened in the same tick is how a
  // function gets itself killed.
  const results: Result[] = [];
  for (let i = 0; i < rows.length; i += 25) {
    results.push(...await Promise.all(rows.slice(i, i + 25).map(deliver)));
  }

  // Settling is not optional: rows left 'sending' would be swept back to
  // pending five minutes later and sent a second time.
  const settled = await rpc("push_settle", { p_results: results });

  return new Response(JSON.stringify({
    sent:    results.filter((r) => r.status === "sent").length,
    failed:  results.filter((r) => r.status !== "sent").length,
    gone:    results.filter((r) => r.gone).length,
    settled: settled.ok
  }), { headers: { "Content-Type": "application/json" } });
});
