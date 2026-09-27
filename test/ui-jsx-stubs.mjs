// Shared JSX import stubbing for the view-level UI tests.
//
// Several view tests (ui-gates, ui-overview, ui-a11y, ...) compile one .jsx
// view with babel + babel-preset-solid into a tmp module inside ui/src. Node
// cannot resolve the relative `.jsx` imports that view declares, so each test
// rewrites `import { a, b } from "../x.jsx"` into inert local stubs before
// compiling. Only the stub table differs per view, so the rewrite lives here
// once instead of being copy-pasted into every view test.
//
// The rewrite is intentionally textual: it runs before babel, so the stubs
// are plain `const` declarations in the compiled module. Names without an
// entry in the stub table become `() => null` so a view that starts importing
// a new export still compiles (and the view assertions, not the stub, decide
// whether the render is correct).

function importPattern(modulePath) {
  return new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*["']${modulePath}["'];?`, "g");
}

function stubDeclaration(name, stubs) {
  return stubs[name] || `const ${name} = () => null;`;
}

function stubLines(names, stubs) {
  return names
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => stubDeclaration(name, stubs))
    .join("\n");
}

function replaceImports(src, modulePath, stubs) {
  return src.replace(importPattern(modulePath), (_match, names) => stubLines(names, stubs));
}

/**
 * Rewrite named imports of the given module paths into local stubs.
 *
 * @param {string} src - module source to rewrite.
 * @param {Array<[string, Record<string, string>]>} specs - `[modulePath, stubs]`
 *   pairs, applied in order. `stubs` maps an export name to the stub source
 *   that replaces the import; missing names fall back to `() => null`.
 * @returns {string} the rewritten source.
 */
export function stubJsxImports(src, specs) {
  let out = src;
  for (const [modulePath, stubs] of specs) {
    out = replaceImports(out, modulePath, stubs);
  }
  return out;
}
