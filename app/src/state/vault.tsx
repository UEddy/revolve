// The vault in React: creating it, unlocking it with the passkey, saving
// every change sealed, and locking again when the phone is put away.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPasskey, evalPrf } from "../lib/passkey.ts";
import { deriveVaultKey, isSealed, seal, store, unseal, type Sealed } from "../lib/vault.ts";
import { emptyVault, type Position, type VaultData } from "../lib/model.ts";

/** Locks after the app has been in the background this long. */
const LOCK_AFTER_HIDDEN_MS = 3 * 60_000;

type Phase = "loading" | "none" | "locked" | "unlocked";

type VaultApi = {
  phase: Phase;
  data: VaultData | null;
  create(): Promise<void>;
  unlock(): Promise<void>;
  lock(): void;
  update(mutate: (d: VaultData) => void): Promise<void>;
  updatePosition(id: string, mutate: (p: Position) => void): Promise<void>;
  exportBackup(): string | null;
  restore(text: string): Promise<void>;
  destroy(): void;
};

const Ctx = createContext<VaultApi | null>(null);

export function useVault(): VaultApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useVault outside VaultProvider");
  return v;
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [data, setData] = useState<VaultData | null>(null);
  // The key and the latest data live in refs too, so saves chain on the
  // newest state rather than whatever a render captured.
  const session = useRef<{ key: CryptoKey; credId: string; data: VaultData } | null>(null);
  const saving = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    try {
      setPhase(store.load() ? "locked" : "none");
    } catch {
      setPhase("locked");
    }
  }, []);

  const open = useCallback((key: CryptoKey, credId: string, d: VaultData) => {
    session.current = { key, credId, data: d };
    setData(d);
    setPhase("unlocked");
  }, []);

  const lock = useCallback(() => {
    session.current = null;
    setData(null);
    setPhase(store.load() ? "locked" : "none");
  }, []);

  const create = useCallback(async () => {
    const made = await createPasskey();
    // Some phones return the PRF output at creation; the rest need one more touch.
    const prf = made.prf ?? (await evalPrf(made.credId)).prf;
    const key = await deriveVaultKey(prf);
    prf.fill(0);
    const d = emptyVault();
    store.save(await seal(key, made.credId, d));
    open(key, made.credId, d);
  }, [open]);

  const unlockSealed = useCallback(async (sealed: Sealed) => {
    const { prf } = await evalPrf(sealed.credId);
    const key = await deriveVaultKey(prf);
    prf.fill(0);
    return { key, d: await unseal(key, sealed) };
  }, []);

  const unlock = useCallback(async () => {
    const sealed = store.load();
    if (!sealed) return setPhase("none");
    const { key, d } = await unlockSealed(sealed);
    open(key, sealed.credId, d);
  }, [open, unlockSealed]);

  const update = useCallback((mutate: (d: VaultData) => void) => {
    const next = saving.current.then(async () => {
      const s = session.current;
      if (!s) throw new Error("vault is locked");
      const d = structuredClone(s.data);
      mutate(d);
      // Sealed and written before anyone sees the change: a burner shown on
      // screen is always already on disk.
      store.save(await seal(s.key, s.credId, d));
      if (session.current === s) {
        s.data = d;
        setData(d);
      }
    });
    saving.current = next.catch(() => {});
    return next;
  }, []);

  const updatePosition = useCallback(
    (id: string, mutate: (p: Position) => void) =>
      update((d) => {
        const p = d.positions.find((x) => x.id === id);
        if (p) mutate(p);
      }),
    [update],
  );

  const exportBackup = useCallback(() => {
    const sealed = store.load();
    return sealed ? JSON.stringify({ app: "revolve", ...sealed }) : null;
  }, []);

  const restore = useCallback(
    async (text: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("That file is not a Revolve backup");
      }
      const { app: _app, ...rest } = parsed as Record<string, unknown>;
      if (!isSealed(rest)) throw new Error("That file is not a Revolve backup");
      // Only replace what is stored once the passkey has opened the backup.
      const { key, d } = await unlockSealed(rest);
      store.save(rest);
      open(key, rest.credId, d);
    },
    [open, unlockSealed],
  );

  const destroy = useCallback(() => {
    store.clear();
    session.current = null;
    setData(null);
    setPhase("none");
  }, []);

  useEffect(() => {
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_HIDDEN_MS && session.current) lock();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [lock]);

  const api = useMemo<VaultApi>(
    () => ({ phase, data, create, unlock, lock, update, updatePosition, exportBackup, restore, destroy }),
    [phase, data, create, unlock, lock, update, updatePosition, exportBackup, restore, destroy],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
