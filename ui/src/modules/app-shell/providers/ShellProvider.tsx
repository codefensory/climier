import { createContext, useContext, type JSX } from "solid-js";
import { useShellController, type ShellController, type ShellProjectIdentity } from "../controllers/useShellController";

/**
 * El contexto no tiene valor por defecto a propósito: un default silencioso haría que un
 * consumidor fuera del provider funcione por accidente con estado que no se comparte.
 */
const ShellContext = createContext<ShellController>();

/**
 * Provee el estado del shell a todo el árbol.
 *
 * Se instancia **una sola vez** acá, no en cada consumidor: el controlador crea signals y
 * listeners de `document`, y duplicarlo duplicaría esos efectos.
 */
export function ShellProvider(props: { children: JSX.Element; projectIdentity?: ShellProjectIdentity }) {
  const shell = useShellController(props.projectIdentity);
  return <ShellContext.Provider value={shell}>{props.children}</ShellContext.Provider>;
}

/** Lee el estado del shell. Debe llamarse dentro de `<ShellProvider>`. */
export function useShell(): ShellController {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell() debe usarse dentro de <ShellProvider>");
  return shell;
}
