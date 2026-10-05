import { describe, expect, it } from "vitest";
import { makeTask } from "../fixtures";
import { groupProgress } from "./projection";

const done = () => makeTask({ status: "done", progress: 100 });
const ready = () => makeTask({ status: "ready", progress: 0 });
const canceled = () => makeTask({ status: "canceled", progress: 0 });

describe("groupProgress", () => {
  it("cuenta lo terminado: una iniciativa casi lista no cae a 0 por una task abierta", () => {
    expect(groupProgress([...Array.from({ length: 89 }, done), ready()])).toBe(99);
  });

  it("excluye las canceladas del denominador", () => {
    expect(groupProgress([done(), canceled()])).toBe(100);
  });

  it("promedia el avance parcial del trabajo en curso", () => {
    expect(groupProgress([done(), makeTask({ status: "in_progress", progress: 50 })])).toBe(75);
  });

  it("un grupo vacío o sólo cancelado queda en 0", () => {
    expect(groupProgress([])).toBe(0);
    expect(groupProgress([canceled()])).toBe(0);
  });
});
