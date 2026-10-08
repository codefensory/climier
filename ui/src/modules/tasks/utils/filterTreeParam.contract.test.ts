import { describe, expect, it } from "vitest";
import contract from "../../app-shell/data/ui-url-contract.json";
import type { FilterGroup } from "../types";
import { encodeFilterTree } from "./filterTreeParam";

function initiativeFilter(value: string): FilterGroup {
  return {
    id: "group-root",
    join: "and",
    conditions: [{ id: "condition-1", join: "and", field: "initiative", operator: "is", values: [value] }],
    groups: [],
  };
}

describe("filter URL contract", () => {
  it.each([
    ["initiative_plain", "auth-migration"],
    ["initiative_special", "diseño UI/UX"],
  ] as const)("encodes %s exactly as the fixture", (fixtureKey, value) => {
    expect(encodeFilterTree(initiativeFilter(value))).toBe(
      JSON.stringify(contract.filter_wire[fixtureKey]),
    );
  });
});
