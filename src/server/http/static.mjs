import fs from "node:fs/promises";
import path from "node:path";

const CACHE_CONTROL_ASSET = "public, max-age=31536000, immutable";
const CACHE_CONTROL_HTML = "no-cache";
const MISSING_BUILD_MESSAGE = "Climier UI build is not available. Run `npm run build` in ui/ and restart the server.\n";

const CONTENT_TYPES = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function configuredPath(root, value) {
  const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  if (!isWithin(root, candidate)) {
    throw new TypeError("server static: indexFile must be inside root");
  }
  return path.relative(root, candidate);
}

function requestPath(request) {
  const target = typeof request.url === "string" && request.url.length > 0 ? request.url : "/";
  const queryStart = target.search(/[?#]/u);
  const rawPath = queryStart === -1 ? target : target.slice(0, queryStart);
  if (!rawPath.startsWith("/")) {
    return null;
  }
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return null;
  }
}

function isUnsafePath(value) {
  return value.includes("\0") || value.split(/[\\/]/u).includes("..");
}

function notFound(response) {
  response.writeHead(404, {
    "cache-control": "no-store",
    "content-length": "0",
  });
  response.end();
}

function missingBuild(response, method) {
  response.writeHead(503, {
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(MISSING_BUILD_MESSAGE)),
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(method === "HEAD" ? undefined : MISSING_BUILD_MESSAGE);
}

async function resolveFile(candidate, root) {
  const relative = path.relative(root, candidate);
  const parts = relative === "" ? [] : relative.split(path.sep);
  let current = root;
  let real = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") {
        return { kind: "missing" };
      }
      return { kind: "unsafe" };
    }
    try {
      real = await fs.realpath(current);
    } catch {
      return { kind: "unsafe" };
    }
    if (!isWithin(root, real)) {
      return { kind: "unsafe" };
    }
  }

  let info;
  try {
    info = await fs.stat(real);
  } catch {
    return { kind: "unsafe" };
  }
  return info.isFile() ? { kind: "file", path: real } : { kind: "missing" };
}

function contentType(file) {
  return CONTENT_TYPES.get(path.extname(file).toLowerCase()) || "application/octet-stream";
}

async function sendFile(request, response, file, { asset }) {
  const body = await fs.readFile(file);
  const type = contentType(file);
  response.writeHead(200, {
    "cache-control": asset ? CACHE_CONTROL_ASSET : type === "text/html; charset=utf-8" ? CACHE_CONTROL_HTML : "no-cache",
    "content-length": String(body.byteLength),
    "content-type": type,
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

export function createStaticHandler({ root, indexFile = "index.html" } = {}) {
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("server static: root is required");
  }
  if (typeof indexFile !== "string" || indexFile.length === 0) {
    throw new TypeError("server static: indexFile is required");
  }

  const configuredRoot = path.resolve(root);
  const indexRelative = configuredPath(configuredRoot, indexFile);

  return async function handleStatic(request, response) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return false;
    }

    const pathname = requestPath(request);
    if (pathname === null || pathname === "/v1" || pathname.startsWith("/v1/")) {
      return false;
    }
    if (!pathname.startsWith("/") || isUnsafePath(pathname)) {
      notFound(response);
      return true;
    }

    let realRoot;
    try {
      realRoot = await fs.realpath(configuredRoot);
    } catch {
      if (pathname === "/") {
        missingBuild(response, request.method);
      } else {
        notFound(response);
      }
      return true;
    }

    const candidate = path.resolve(realRoot, `.${pathname}`);
    if (!isWithin(realRoot, candidate)) {
      notFound(response);
      return true;
    }

    const direct = await resolveFile(candidate, realRoot);
    if (direct.kind === "unsafe") {
      notFound(response);
      return true;
    }

    let file = direct.kind === "file" ? direct.path : null;
    if (!file) {
      const fallback = await resolveFile(path.join(realRoot, indexRelative), realRoot);
      if (fallback.kind !== "file") {
        if (pathname === "/" && fallback.kind === "missing") {
          missingBuild(response, request.method);
        } else {
          notFound(response);
        }
        return true;
      }
      file = fallback.path;
    }

    await sendFile(request, response, file, {
      asset: direct.kind === "file" && pathname.startsWith("/assets/"),
    });
    return true;
  };
}
