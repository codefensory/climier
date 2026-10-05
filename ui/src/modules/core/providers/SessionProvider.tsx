import { createContext, createSignal, onMount, useContext, type Accessor, type JSX } from "solid-js";
import { AUTH_STORAGE_KEY } from "../http/protocol";
import { createHttpClient, type StorageLike } from "../http/client";

export type SessionController = {
  token: Accessor<string | null>;
  authenticated: Accessor<boolean>;
  busy: Accessor<boolean>;
  error: Accessor<string | null>;
  client: ReturnType<typeof createHttpClient>;
  login: (password: string) => Promise<boolean>;
  logout: () => void;
  clearError: () => void;
};

const SessionContext = createContext<SessionController>();

function getStorage(): StorageLike | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function SessionProvider(props: { children: JSX.Element; storage?: StorageLike | null; probe?: boolean }) {
  const storage = props.storage === undefined ? getStorage() : props.storage;
  const [token, setToken] = createSignal<string | null>(storage?.getItem(AUTH_STORAGE_KEY) ?? null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // True when the origin answers the catalog without a bearer (the loopback `climier ui` adapter).
  const [open, setOpen] = createSignal(false);
  const probe = props.probe ?? true;

  // A request in flight must not reopen the app after an explicit login/logout or a 401.
  let accessAttempt = 0;
  const cancelProbe = () => { accessAttempt += 1; };
  const clearToken = () => {
    cancelProbe();
    setToken(null);
    storage?.removeItem(AUTH_STORAGE_KEY);
    client.clearToken();
  };
  const client = createHttpClient({ getToken: token, storage, onUnauthorized: clearToken });

  onMount(() => {
    if (!probe || token()) return;
    const attempt = ++accessAttempt;
    void client.getProjects().then(() => {
      if (attempt === accessAttempt) setOpen(true);
    }).catch(() => {});
  });

  const login = async (password: string): Promise<boolean> => {
    cancelProbe();
    setBusy(true);
    setError(null);
    try {
      const result = await client.login(password);
      setToken(result.token);
      storage?.setItem(AUTH_STORAGE_KEY, result.token);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign in");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const logout = () => {
    setOpen(false);
    clearToken();
    setError(null);
  };

  const controller: SessionController = {
    token,
    authenticated: () => Boolean(token()) || open(),
    busy,
    error,
    client,
    login,
    logout,
    clearError: () => setError(null),
  };

  return <SessionContext.Provider value={controller}>{props.children}</SessionContext.Provider>;
}

export function useSession(): SessionController {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession() must be used inside <SessionProvider>");
  return session;
}
