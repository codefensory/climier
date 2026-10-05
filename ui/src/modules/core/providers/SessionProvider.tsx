import { createContext, createSignal, useContext, type Accessor, type JSX } from "solid-js";
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

export function SessionProvider(props: { children: JSX.Element; storage?: StorageLike | null }) {
  const storage = props.storage === undefined ? getStorage() : props.storage;
  const [token, setToken] = createSignal<string | null>(storage?.getItem(AUTH_STORAGE_KEY) ?? null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const clearToken = () => {
    setToken(null);
    storage?.removeItem(AUTH_STORAGE_KEY);
    client.clearToken();
  };
  const client = createHttpClient({ getToken: token, storage, onUnauthorized: clearToken });

  const login = async (password: string): Promise<boolean> => {
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
    clearToken();
    setError(null);
  };

  const controller: SessionController = {
    token,
    authenticated: () => Boolean(token()),
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
