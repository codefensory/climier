import { createContext, useContext, type JSX } from "solid-js";

export type RuntimeMode = "live" | "fixture";
export type RuntimeController = {
  mode: RuntimeMode;
  fixtureSnapshot: unknown;
};

const RuntimeContext = createContext<RuntimeController>();

export function RuntimeProvider(props: { children: JSX.Element; mode?: RuntimeMode; fixtureSnapshot?: unknown }) {
  return <RuntimeContext.Provider value={{ mode: props.mode ?? "live", fixtureSnapshot: props.fixtureSnapshot }}>{props.children}</RuntimeContext.Provider>;
}

export function useRuntime(): RuntimeController {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("useRuntime() must be used inside <RuntimeProvider>");
  return runtime;
}
