import { HashRouter, Route } from "@solidjs/router";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORAGE_KEY } from "../../core/http/protocol";
import type { StorageLike } from "../../core/http/client";
import { RuntimeProvider, SessionProvider } from "../../core";
import { ProjectProvider, useProjectData, type ProjectDataController } from "./ProjectProvider";

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeout = 1_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for ProjectProvider");
    await wait(5);
  }
}

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("ProjectProvider", () => {
  it("does not refetch a snapshot loop and can switch projects", async () => {
    const projects = [
      { project_id: "project-one", name: "One", revision: 1, node_count: 1, updated_at: null },
      { project_id: "project-two", name: "Two", revision: 1, node_count: 1, updated_at: null },
    ];
    const snapshotRequests = new Map<string, number>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path === "/v1/projects") {
        return new Response(JSON.stringify({ projects }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const snapshotMatch = path.match(/^\/v1\/projects\/([^/]+)\/ui\/snapshot$/);
      if (snapshotMatch) {
        const projectId = decodeURIComponent(snapshotMatch[1]);
        snapshotRequests.set(projectId, (snapshotRequests.get(projectId) ?? 0) + 1);
        await wait(0);
        return new Response(JSON.stringify({
          result: {
            project: { project_id: projectId, revision: 1 },
            nodes: { [`${projectId}-node`]: {} },
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"1"' },
        });
      }
      if (path.endsWith("/ui/events")) return new Response(null, { status: 200 });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    let projectData: ProjectDataController | undefined;
    const storage = memoryStorage({ [AUTH_STORAGE_KEY]: "test-token" });
    const host = document.createElement("div");
    document.body.append(host);
    window.history.replaceState(null, "", "#/");
    dispose = render(() => (
      <RuntimeProvider>
        <SessionProvider storage={storage}>
          <HashRouter>
            <Route path="*" component={() => (
              <ProjectProvider>
                <CaptureProjectData capture={(value) => { projectData = value; }} />
              </ProjectProvider>
            )} />
          </HashRouter>
        </SessionProvider>
      </RuntimeProvider>
    ), host);

    await waitFor(() => projectData?.projectId() === "project-one" && projectData?.projectStatus() === "ready");
    await wait(20);
    expect(snapshotRequests.get("project-one")).toBeLessThanOrEqual(2);

    projectData?.selectProject("project-two");
    await waitFor(() => projectData?.projectId() === "project-two"
      && projectData?.snapshot() !== null
      && projectData?.projectStatus() === "ready");
    await wait(20);
    expect(projectData?.snapshot()).toMatchObject({ project: { project_id: "project-two" } });
    expect(snapshotRequests.get("project-two")).toBeLessThanOrEqual(2);
    expect(fetchMock).toHaveBeenCalled();
  });
});

function CaptureProjectData(props: { capture: (value: ProjectDataController) => void }) {
  props.capture(useProjectData());
  return null;
}
