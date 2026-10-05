import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";
import { snapshot } from "./modules/tasks/data/snapshot";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

describe("live project app shell", () => {
  it("mounts the fixture through the same session and project providers", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <App mode="fixture" fixtureSnapshot={snapshot} />, host);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(host.querySelector('[data-testid="dashboard-layout"]')).not.toBeNull();
    expect(host.querySelector('[data-project-trigger]')).not.toBeNull();
    expect(host.querySelector('[data-testid="login-page"]')).toBeNull();

    const content = host.querySelector<HTMLElement>('main[data-testid="main-content"]');
    expect(content?.classList.contains("main-content-view")).toBe(true);
    expect(content?.classList.contains("main-content-visible")).toBe(true);
    expect(content?.parentElement?.classList.contains("main-content-frame")).toBe(true);
    expect(content?.previousElementSibling?.getAttribute("data-testid")).toBe("tasks-breadcrumb");
  });
});
