import { describe, expect, it } from "vitest";
import { makeTask } from "../fixtures";
import type { ClimierSnapshot } from "./contract";
import { groupProgress, projectTaskDetail, projectTasks } from "./projection";

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

/** Snapshot mínimo con una task `open` por id. */
const snapshotWith = (id: string) => ({
  nodes: { [id]: { id, kind: "resolvable", subkind: "task", title: id, status: "open" } },
  edges: [],
  initiatives: {},
  log: [],
}) as unknown as ClimierSnapshot;

/**
 * Snapshot con un thread de notas y su log equivalente.
 *
 * El `add-note` del log duplica la nota que ya está en `node.notes`: es exactamente el caso que la
 * proyección tiene que colapsar en una sola entrada.
 */
const timelineSnapshot = () => ({
  nodes: {
    T1: {
      id: "T1",
      kind: "resolvable",
      subkind: "task",
      title: "T1",
      status: "in_progress",
      notes: [
        { ts: "2026-10-03T10:00:00.000Z", agent: "climier-worker", text: "Primera nota del thread." },
        { ts: "2026-10-03T12:00:00.000Z", agent: "reviewer", text: "Segunda nota del thread." },
      ],
    },
    T2: { id: "T2", kind: "resolvable", subkind: "task", title: "T2", status: "open" },
  },
  edges: [],
  initiatives: {},
  log: [],
  recent_activity: [
    { ts: "2026-10-03T09:00:00.000Z", agent: "orchestrator", action: "add-task", node: "T1" },
    { ts: "2026-10-03T10:00:00.000Z", agent: "climier-worker", action: "add-note", node: "T1", note: "Primera nota del thread." },
    { ts: "2026-10-03T11:00:00.000Z", agent: "climier-worker", action: "take", node: "T2" },
    { ts: "2026-10-03T13:00:00.000Z", agent: "climier-worker", action: "task.submit", node: "T1" },
  ],
}) as unknown as ClimierSnapshot;

describe("projectTaskDetail", () => {
  it("mezcla notas y actividad en un solo hilo cronológico", () => {
    const detail = projectTaskDetail(timelineSnapshot(), "T1")!;
    expect(detail.activity.map((entry) => entry.kind)).toEqual(["created", "comment", "comment", "submit"]);
  });

  it("toma el cuerpo de la nota del thread, no el nota del log", () => {
    const detail = projectTaskDetail(timelineSnapshot(), "T1")!;
    const notes = detail.activity.filter((entry) => entry.kind === "comment");
    expect(notes.map((entry) => entry.comment)).toEqual(["Primera nota del thread.", "Segunda nota del thread."]);
    expect(notes.map((entry) => entry.author)).toEqual(["climier-worker", "reviewer"]);
    expect(notes.every((entry) => entry.text === "commented")).toBe(true);
  });

  it("no filtra actividad de otros nodes", () => {
    const detail = projectTaskDetail(timelineSnapshot(), "T1")!;
    expect(detail.activity.some((entry) => entry.text === "claimed it")).toBe(false);
  });
});

describe("projectTasks", () => {
  it("cachea la proyección por identidad de snapshot", () => {
    const snapshot = snapshotWith("T1");
    const first = projectTasks(snapshot);
    expect(first.map((task) => task.id)).toEqual(["T1"]);
    expect(projectTasks(snapshot)).toBe(first);
  });

  it("reproyecta cuando llega un snapshot nuevo: el caché no filtra vocabulario viejo", () => {
    const first = projectTasks(snapshotWith("T1"));
    expect(projectTasks(snapshotWith("T1"))).not.toBe(first);
  });
});
