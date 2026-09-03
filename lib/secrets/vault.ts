import type postgres from "postgres";
import { appDb } from "@/lib/db/app";

/**
 * Connector tokens live in Supabase Vault. Tables hold a `secret_ref` — the
 * Vault secret's name — and nothing else. The ref shape is enforced by a
 * check constraint on context_connections, so a raw token can't be written
 * where a ref belongs even by mistake.
 *
 * Refs look like `vault:connection:<uuid>` and are stable across token
 * rotation: `put` updates in place when the name exists.
 */

export const SECRET_REF_RE = /^vault:[a-z0-9][a-z0-9:_-]*$/;

export interface SecretStore {
  /** Create or rotate the secret behind `ref`. Returns the ref. */
  put(ref: string, value: string, description?: string): Promise<string>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
}

export function connectionSecretRef(connectionId: string): string {
  return `vault:connection:${connectionId.toLowerCase()}`;
}

export function assertSecretRef(ref: string): void {
  if (!SECRET_REF_RE.test(ref)) throw new Error(`invalid secret ref: ${ref.slice(0, 12)}…`);
}

/** Guard against a token being logged or persisted where a ref belongs. */
export function looksLikeSecret(value: string): boolean {
  return !SECRET_REF_RE.test(value) && value.length >= 16;
}

export function memorySecrets(): SecretStore & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async put(ref, value) {
      assertSecretRef(ref);
      store.set(ref, value);
      return ref;
    },
    async get(ref) {
      return store.get(ref) ?? null;
    },
    async delete(ref) {
      store.delete(ref);
    },
  };
}

/**
 * Supabase Vault. Requires the `supabase_vault` extension and the service
 * connection; `vault.decrypted_secrets` is readable only by roles the
 * project grants, which never includes the customer app or the renderer.
 */
export function vaultSecrets(sql: postgres.Sql = appDb()): SecretStore {
  return {
    async put(ref, value, description) {
      assertSecretRef(ref);
      const [existing] = await sql<{ id: string }[]>`select id from vault.secrets where name = ${ref}`;
      if (existing) {
        await sql`select vault.update_secret(${existing.id}::uuid, ${value}, ${ref}, ${description ?? null})`;
      } else {
        await sql`select vault.create_secret(${value}, ${ref}, ${description ?? null})`;
      }
      return ref;
    },
    async get(ref) {
      assertSecretRef(ref);
      const [row] = await sql<{ decrypted_secret: string }[]>`
        select decrypted_secret from vault.decrypted_secrets where name = ${ref} limit 1`;
      return row?.decrypted_secret ?? null;
    },
    async delete(ref) {
      assertSecretRef(ref);
      await sql`delete from vault.secrets where name = ${ref}`;
    },
  };
}
