import { useSearchParams } from "@solidjs/router";
import { createContext, createEffect, createMemo, createSignal, onCleanup, untrack, useContext, type Accessor, type JSX } from "solid-js";
import { backoffDelay, consumeSse, useRuntime, useSession, waitForBackoff, type ProjectSummary, type RuntimeMode } from "../../core";

export type ProjectStatus = "loading" | "ready" | "empty" | "unknown" | "uninitialized" | "error";
export type ConnectionStatus = "live" | "stale" | "offline";

export type ProjectDataController = {
  projects: Accessor<ProjectSummary[]>;
  selectedProject: Accessor<ProjectSummary | null>;
  projectId: Accessor<string | null>;
  snapshot: Accessor<unknown | null>;
  projectStatus: Accessor<ProjectStatus>;
  connection: Accessor<ConnectionStatus>;
  errorMessage: Accessor<string | null>;
  lastUpdated: Accessor<number | null>;
  retry: () => void;
  refreshProjects: () => void;
  selectProject: (projectId: string) => void;
};

const ProjectContext = createContext<ProjectDataController>();

function fixtureProject(snapshot: unknown): ProjectSummary | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const project = (snapshot as { project?: { project_id?: string | null; id?: string | null; root?: string; name?: string | null; revision?: number; generated_at?: string | null } }).project;
  const projectId = project?.project_id ?? project?.id;
  if (!project || !projectId) return null;
  const rootName = project.name?.trim() || project.root?.split(/[\\/]/).filter(Boolean).at(-1) || projectId;
  const nodes = (snapshot as { nodes?: Record<string, unknown> }).nodes;
  const revision = project.revision ?? (snapshot as { source_revision?: number }).source_revision;
  return {
    project_id: projectId,
    name: rootName,
    revision: typeof revision === "number" && Number.isInteger(revision) ? revision : 0,
    node_count: nodes ? Object.keys(nodes).length : 0,
    updated_at: project.generated_at ?? (snapshot as { generated_at?: string }).generated_at ?? null,
  };
}

function isUnauthorized(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && (error as { status?: number }).status === 401);
}

function isStateUninitialized(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "STATE_NOT_INITIALIZED");
}

export function ProjectProvider(props: { children: JSX.Element; mode?: RuntimeMode; fixtureSnapshot?: unknown }) {
  const runtime = useRuntime();
  const session = useSession();
  const mode = props.mode ?? runtime.mode;
  const fixture = props.fixtureSnapshot ?? runtime.fixtureSnapshot;
  const fixtureRecord = mode === "fixture" ? fixtureProject(fixture) : null;
  const [query, setSearchParams] = useSearchParams();
  const [projects, setProjects] = createSignal<ProjectSummary[]>(fixtureRecord ? [fixtureRecord] : []);
  const [snapshot, setSnapshot] = createSignal<unknown | null>(mode === "fixture" ? fixture : null);
  const [projectStatus, setProjectStatus] = createSignal<ProjectStatus>(mode === "fixture" && fixtureRecord ? "ready" : "loading");
  const [connection, setConnection] = createSignal<ConnectionStatus>(mode === "fixture" ? "live" : "offline");
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  const [lastUpdated, setLastUpdated] = createSignal<number | null>(mode === "fixture" ? Date.now() : null);
  const [catalogStatus, setCatalogStatus] = createSignal<"loading" | "ready" | "empty" | "error">(fixtureRecord ? "ready" : "loading");

  const selectedId = () => typeof query.project === "string" ? query.project : query.project?.[0] ?? null;
  const selectedProject = createMemo(() => projects().find((project) => project.project_id === selectedId()) ?? (selectedId() ? null : projects()[0] ?? null));
  const projectId = () => selectedId() ?? (mode === "fixture" ? projects()[0]?.project_id ?? null : null);
  let activeAbort: AbortController | undefined;
  let activeRun = 0;
  let catalogRun = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const stopStream = () => {
    activeAbort?.abort();
    activeAbort = undefined;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const selectProject = (id: string) => {
    if (!projects().some((project) => project.project_id === id)) return;
    setSearchParams({ project: id });
  };

  const loadProjects = async () => {
    if (mode === "fixture" || !session.authenticated()) return;
    const run = ++catalogRun;
    setCatalogStatus("loading");
    try {
      const result = await session.client.getProjects();
      if (run !== catalogRun) return;
      setProjects(result);
      setCatalogStatus(result.length ? "ready" : "empty");
      if (result.length === 0) {
        stopStream();
        setSnapshot(null);
        setProjectStatus("empty");
        setConnection("offline");
      }
    } catch (error) {
      if (run !== catalogRun || isUnauthorized(error)) return;
      setCatalogStatus("error");
      setProjectStatus("error");
      setConnection("offline");
      setErrorMessage(error instanceof Error ? error.message : "Unable to load projects");
    }
  };

  const refreshSnapshot = async (id: string, run: number, etag: { value: string | null }) => {
    try {
      const result = await session.client.getSnapshot<unknown>(id, etag.value);
      if (run !== activeRun || activeAbort?.signal.aborted) return;
      if (result.etag) etag.value = result.etag;
      if (result.status === 304) return;
      if (result.snapshot === null) return;
      setSnapshot(result.snapshot);
      setProjectStatus("ready");
      setConnection("live");
      setErrorMessage(null);
      setLastUpdated(Date.now());
      const revision = readRevision(result.snapshot);
      const nodeCount = readNodeCount(result.snapshot);
      setProjects((current) => {
        let changed = false;
        const next = current.map((project) => {
          if (project.project_id !== id) return project;
          const nextRevision = revision ?? project.revision;
          const nextNodeCount = nodeCount ?? project.node_count;
          if (nextRevision === project.revision && nextNodeCount === project.node_count) return project;
          changed = true;
          return { ...project, revision: nextRevision, node_count: nextNodeCount };
        });
        return changed ? next : current;
      });
    } catch (error) {
      if (run !== activeRun || activeAbort?.signal.aborted || isUnauthorized(error)) return;
      if (isStateUninitialized(error)) {
        setProjectStatus("uninitialized");
        setConnection("offline");
        setErrorMessage("This project has no initialized state yet.");
      } else {
        if (snapshot() === null) setProjectStatus("error");
        setConnection("stale");
        setErrorMessage(error instanceof Error ? error.message : "Unable to refresh project");
      }
    }
  };

  const connectEvents = async (id: string, run: number, etag: { value: string | null }, signal: AbortSignal) => {
    let attempt = 0;
    while (!signal.aborted && run === activeRun) {
      try {
        const response = await session.client.openEvents(id, signal);
        attempt = 0;
        setConnection("live");
        await consumeSse(response, async (message) => {
          if (!message.data) return;
          let payload: { revision?: number };
          try { payload = JSON.parse(message.data) as { revision?: number }; } catch { return; }
          if (Number.isInteger(payload.revision) && payload.revision !== readRevision(snapshot())) {
            await refreshSnapshot(id, run, etag);
          }
        }, signal);
        if (signal.aborted) return;
        throw new Error("Live update stream closed");
      } catch (error) {
        if (signal.aborted || run !== activeRun || isUnauthorized(error)) return;
        setConnection(attempt >= 3 ? "offline" : "stale");
        attempt += 1;
        await waitForBackoff(backoffDelay(attempt), signal);
      }
    }
  };

  const loadProject = async (id: string) => {
    stopStream();
    const controller = new AbortController();
    activeAbort = controller;
    const run = ++activeRun;
    const etag = { value: null as string | null };
    setProjectStatus("loading");
    setConnection("stale");
    setErrorMessage(null);
    try {
      await refreshSnapshot(id, run, etag);
      if (run !== activeRun || controller.signal.aborted || projectStatus() !== "ready") return;
      void connectEvents(id, run, etag, controller.signal);
    } catch (error) {
      if (run !== activeRun || controller.signal.aborted || isUnauthorized(error)) return;
      setProjectStatus(isStateUninitialized(error) ? "uninitialized" : "error");
      setConnection("offline");
      setErrorMessage(error instanceof Error ? error.message : "Unable to load project");
    }
  };

  const retry = () => {
    if (mode === "fixture") return;
    if (projectId() && selectedProject()) void loadProject(projectId()!);
    else void loadProjects();
  };

  createEffect(() => {
    if (mode === "fixture") return;
    if (session.authenticated()) void loadProjects();
    else {
      catalogRun += 1;
      stopStream();
      setProjects([]);
      setSnapshot(null);
      setProjectStatus("loading");
    }
  });

  createEffect(() => {
    const list = projects();
    if (mode !== "fixture" && !selectedId() && list[0]) setSearchParams({ project: list[0].project_id });
  });

  createEffect(() => {
    const id = selectedId();
    const catalog = catalogStatus();
    const list = untrack(projects);
    if (!id) {
      stopStream();
      if (catalog === "empty") setProjectStatus("empty");
      return;
    }
    if (!list.some((project) => project.project_id === id)) {
      stopStream();
      setSnapshot(null);
      setProjectStatus(catalog === "loading" ? "loading" : "unknown");
      setConnection("offline");
      return;
    }
    if (mode === "fixture") return;
    void loadProject(id);
    onCleanup(stopStream);
  });

  onCleanup(() => {
    catalogRun += 1;
    activeRun += 1;
    stopStream();
  });

  const controller: ProjectDataController = {
    projects,
    selectedProject,
    projectId,
    snapshot,
    projectStatus,
    connection,
    errorMessage,
    lastUpdated,
    retry,
    refreshProjects: () => void loadProjects(),
    selectProject,
  };

  return <ProjectContext.Provider value={controller}>{props.children}</ProjectContext.Provider>;
}

function readRevision(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const project = (value as { project?: { revision?: number } }).project;
  const sourceRevision = (value as { source_revision?: number }).source_revision;
  if (Number.isInteger(project?.revision)) return project!.revision!;
  return Number.isInteger(sourceRevision) ? sourceRevision! : null;
}

function readNodeCount(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const nodes = (value as { nodes?: Record<string, unknown> }).nodes;
  return nodes && typeof nodes === "object" ? Object.keys(nodes).length : null;
}

export function useProjectData(): ProjectDataController {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProjectData() must be used inside <ProjectProvider>");
  return value;
}
