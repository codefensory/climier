import { createEffect, onCleanup } from "solid-js";
import { createJSXDecorator } from "storybook-solidjs-vite";

export const withTheme = createJSXDecorator((Story, context) => {
  const root = document.documentElement;
  const body = document.body;
  const previousTheme = root.dataset.theme;
  const previousRootBackground = root.style.backgroundColor;
  const previousBodyBackground = body.style.backgroundColor;
  const applyTheme = () => {
    root.dataset.theme = context.globals.theme === "dark" ? "dark" : "light";
    root.style.backgroundColor = "var(--color-canvas)";
    body.style.backgroundColor = "var(--color-canvas)";
  };

  // Apply synchronously so the story is mounted with the right tokens, then keep the
  // canvas in sync when the toolbar changes globals without remounting the story.
  applyTheme();
  createEffect(applyTheme);

  onCleanup(() => {
    if (previousTheme === undefined) delete root.dataset.theme;
    else root.dataset.theme = previousTheme;
    root.style.backgroundColor = previousRootBackground;
    body.style.backgroundColor = previousBodyBackground;
  });

  return <Story />;
});
