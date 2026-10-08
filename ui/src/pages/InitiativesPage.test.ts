import { describe, expect, it } from "vitest";
import type { ClimierNode, ClimierSnapshot } from "../modules/tasks";
import { initiativeRows } from "./InitiativesPage";

function snapshotWith(nodes: Record<string, ClimierNode>): ClimierSnapshot {
  return {
    version: 1,
    initiatives: {
      ghost: { desc: "Recién creada, todavía sin trabajo", created_at: "2026-10-03T00:00:00.000Z" },
      gated: { desc: "Sólo una decisión pendiente", created_at: "2026-10-03T00:00:00.000Z" },
      real: { desc: "Trabajo en curso", created_at: "2026-10-03T00:00:00.000Z" },
    },
    nodes,
    edges: [],
    log: [],
  } as unknown as ClimierSnapshot;
}

const task = (id: string, initiative: string): ClimierNode => ({
  id,
  kind: "resolvable",
  subkind: "task",
  title: id,
  status: "open",
  initiative,
});

const gate = (id: string, initiative: string, status: string): ClimierNode => ({
  id,
  kind: "resolvable",
  subkind: "gate",
  title: id,
  status,
  initiative,
});

describe("initiativeRows", () => {
  it("omite una iniciativa que no tiene tasks ni gates", () => {
    const rows = initiativeRows(snapshotWith({ "T-real": task("T-real", "real") }));
    expect(rows.map((row) => row.name)).toEqual(["real"]);
  });

  it("mantiene una iniciativa que sólo tiene una gate abierta", () => {
    const rows = initiativeRows(snapshotWith({ "G-gated": gate("G-gated", "gated", "open") }));
    expect(rows.map((row) => row.name)).toEqual(["gated"]);
    expect(rows[0].gates).toBe(1);
  });

  it("omite una iniciativa cuyas gates ya no están pendientes", () => {
    const rows = initiativeRows(snapshotWith({ "G-gated": gate("G-gated", "gated", "resolved") }));
    expect(rows).toEqual([]);
  });
});
