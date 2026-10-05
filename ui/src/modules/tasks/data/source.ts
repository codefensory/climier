import { snapshot as fixtureSnapshot } from "./snapshot";
import type { ClimierSnapshot } from "./climier/contract";

// Storybook y las baselines usan el fixture; el snapshot real de 5 MB es opt-in.
export const usingRealSnapshot =
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  window.parent === window &&
  new URLSearchParams(window.location.search).get("data") === "real";

export const snapshot: ClimierSnapshot = usingRealSnapshot
  // El generador produce el contrato ClimierSnapshot; JSON pierde los unions al inferirse.
  ? ((await import("./climier/realSnapshot.json")).default as ClimierSnapshot)
  : fixtureSnapshot;
