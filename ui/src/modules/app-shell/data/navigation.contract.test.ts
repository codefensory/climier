import { describe, expect, it } from "vitest";
import contract from "./ui-url-contract.json";
import { isGateDetailPath, isTaskDetailPath, navPaths } from "./navigation";

describe("navigation URL contract", () => {
  it("keeps navPaths aligned with the fixture routes", () => {
    const routes = Object.fromEntries(
      Object.entries(navPaths).map(([view, path]) => [view.toLowerCase(), path]),
    );

    expect(routes).toEqual(contract.routes);
  });

  it("recognizes task and gate detail paths from the fixture", () => {
    const id = "T-contract-1";

    expect(isTaskDetailPath(contract.detail.task.replace(":id", id))).toBe(true);
    expect(isGateDetailPath(contract.detail.gate.replace(":id", id))).toBe(true);
  });
});
