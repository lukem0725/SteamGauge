/**
 * lib/supabase/server.ts
 *
 * The ONLY Supabase client in SteamLite. Server-side, administrative, and
 * created with the secret key (sb_secret_...). That key runs as the
 * `service_role` Postgres role and BYPASSES Row Level Security by design.
 *
 * Every table has RLS enabled with zero policies (architecture doc 6.3), so
 * this client is the single path to the data. Two consequences:
 *
 *   1. Never import this file from a Client Component. The `server-only`
 *      import below turns that mistake into a build error.
 *   2. RLS will not protect you here. Every query on user-owned rows must
 *      filter by the SteamID taken from the verified session, never from a
 *      request parameter.
 *
 * Required environment variables:
 *   NEXT_PUBLIC_SUPABASE_URL   https://<project-ref>.supabase.co
 *   SUPABASE_SECRET_KEY        sb_secret_...   (never NEXT_PUBLIC_)
 */
import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SECRET_KEY_PREFIX = "sb_secret_";
const PUBLISHABLE_KEY_PREFIX = "sb_publishable_";

/** Thrown when the Supabase environment is missing or unsafe. Never contains a key. */
export class SupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseConfigError";
  }
}

function readSupabaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!raw) {
    throw new SupabaseConfigError("NEXT_PUBLIC_SUPABASE_URL is not set.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SupabaseConfigError("NEXT_PUBLIC_SUPABASE_URL is not a valid URL.");
  }

  // Plain http is allowed only for the local Supabase CLI stack.
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new SupabaseConfigError("NEXT_PUBLIC_SUPABASE_URL must use https.");
  }

  return url.origin;
}

function readSecretKey(): string {
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!key) {
    throw new SupabaseConfigError("SUPABASE_SECRET_KEY is not set.");
  }
  if (key.startsWith(PUBLISHABLE_KEY_PREFIX)) {
    throw new SupabaseConfigError(
      "SUPABASE_SECRET_KEY holds a publishable key. With RLS deny-all it cannot " +
        "read or write anything. Use the secret key (sb_secret_...).",
    );
  }
  if (!key.startsWith(SECRET_KEY_PREFIX)) {
    throw new SupabaseConfigError(
      "SUPABASE_SECRET_KEY must be a Supabase secret key (sb_secret_...). " +
        "Legacy service_role JWT keys are not supported.",
    );
  }
  return key;
}

/**
 * Next.js can cache `fetch` GET responses inside Route Handlers. A database
 * read must never be served from that cache, so every request this client
 * makes opts out explicitly.
 */
const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

function createAdminClient(): SupabaseClient {
  return createClient(readSupabaseUrl(), readSecretKey(), {
    auth: {
      // We run our own sessions (architecture doc 6.2). Supabase Auth is unused,
      // and a server process must not persist or refresh anyone's auth state.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    db: { schema: "public" },
    global: {
      fetch: noStoreFetch,
      headers: { "X-Client-Info": "steamlite-server" },
    },
  });
}

let adminClient: SupabaseClient | undefined;

/**
 * Returns the shared admin client, creating it on first use.
 *
 * Creation is lazy so that `next build` and unit tests can import this module
 * without the secrets present. One instance is reused per warm serverless
 * instance; the client is stateless, so sharing it across requests is safe.
 *
 * @throws SupabaseConfigError if the environment is missing or unsafe.
 */
export function getSupabaseAdmin(): SupabaseClient {
  adminClient ??= createAdminClient();
  return adminClient;
}
