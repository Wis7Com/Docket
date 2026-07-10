import { sharedClient, SupabaseShimClient } from "../db/supabaseShim";

/**
 * Returns the SQLite-backed Supabase compatibility client. The shim implements
 * the subset of @supabase/supabase-js used by route handlers — see
 * ../db/supabaseShim.ts for the coverage list.
 *
 * Existing callers do `db.from('x').select('*').eq(...)` etc. unchanged.
 */
export function createServerSupabase(): SupabaseShimClient {
  return sharedClient;
}
