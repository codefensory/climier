import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  artifactPathForRoute,
  normalizeBasePath,
  prerenderRoutes,
  publicBasePath,
} from './site-paths.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = path.resolve(SCRIPT_DIR, '..');

export const DEFAULT_ARTIFACT_ROOT = path.join(DOCS_ROOT, '.output/public');
export const DEFAULT_CONTENT_ROOT = path.join(DOCS_ROOT, 'content/docs');

async function readFileIfPresent(filePath) {
  try {
    const entry = await stat(filePath);
    if (!entry.isFile()) return undefined;
    return await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * A GitHub Pages artifact is served with its root mapped onto the project path,
 * so the checks below are what "the deployed URL works" reduces to on disk: a
 * real `index.html` at the root, no second copy of the base directory, a file
 * per prerendered route, and URLs that agree with the base path the host serves.
 */
export async function checkPagesArtifact(
  rootDir = DEFAULT_ARTIFACT_ROOT,
  { basePath = '', contentRoot = DEFAULT_CONTENT_ROOT } = {},
) {
  const resolvedRoot = path.resolve(rootDir);
  const publicBase = publicBasePath(basePath);
  const violations = [];
  const report = (code, file, message) => violations.push({ code, file, message });

  const home = await readFileIfPresent(path.join(resolvedRoot, 'index.html'));
  if (!home) {
    report('MISSING_HOME', 'index.html', `the artifact has no index.html, so ${publicBase} has nothing to serve`);
  } else {
    const html = home.toString('utf8');
    if (html.trim().length === 0) {
      report('EMPTY_HOME', 'index.html', 'index.html is empty');
    } else if (!/<html[\s>]/i.test(html)) {
      report('INVALID_HOME', 'index.html', 'index.html is not an HTML document');
    }
    if (!html.includes(`${publicBase}assets/`)) {
      report(
        'BASE_MISMATCH',
        'index.html',
        `index.html does not reference assets under ${publicBase}assets/, so the base path and the artifact layout disagree`,
      );
    }
  }

  if (basePath) {
    const nestedSegment = basePath.replace(/^\/+/, '').split('/')[0];
    if (nestedSegment && (await pathExists(path.join(resolvedRoot, nestedSegment)))) {
      report(
        'NESTED_BASE_PATH',
        `${nestedSegment}/`,
        `the artifact contains "${nestedSegment}/", which duplicates the base path the host already prefixes`,
      );
    }
  }

  for (const route of prerenderRoutes(basePath, contentRoot)) {
    const relative = artifactPathForRoute(route, basePath);
    const contents = await readFileIfPresent(path.join(resolvedRoot, relative));
    if (!contents) report('MISSING_ROUTE', relative, `route ${route} was not prerendered`);
    else if (contents.toString('utf8').trim().length === 0) {
      report('EMPTY_ROUTE', relative, `route ${route} prerendered to an empty file`);
    }
  }

  const searchIndex = await readFileIfPresent(path.join(resolvedRoot, 'api/search'));
  if (!searchIndex) report('MISSING_SEARCH_INDEX', 'api/search', 'the static search index was not written');
  else if (searchIndex.length === 0) report('EMPTY_SEARCH_INDEX', 'api/search', 'the static search index is empty');

  if (!(await pathExists(path.join(resolvedRoot, '.nojekyll')))) {
    report('MISSING_NOJEKYLL', '.nojekyll', 'GitHub Pages drops files under _-prefixed asset names without .nojekyll');
  }

  return { rootDir: resolvedRoot, basePath, violations };
}

export const checkPagesArtifactLayout = checkPagesArtifact;

function printReport(result) {
  if (result.violations.length === 0) {
    console.log(`Pages artifact guardrail passed (${result.rootDir}, base path "${result.basePath || '/'}").`);
    return;
  }

  console.error(`Pages artifact guardrail failed (${result.violations.length} violation(s)).`);
  for (const finding of result.violations) {
    console.error(`- ${finding.file} [${finding.code}] ${finding.message}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  printReport(
    await checkPagesArtifact(process.argv[2] || DEFAULT_ARTIFACT_ROOT, {
      basePath: normalizeBasePath(),
      contentRoot: DEFAULT_CONTENT_ROOT,
    }),
  );
}
