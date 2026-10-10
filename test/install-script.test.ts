import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(root, "scripts", "install.sh");

async function withFixture(run: (fixture: { root: string; installDir: string; baseUrl: string; binary: Buffer }) => Promise<void>) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "climier-installer-"));
  const installDir = path.join(fixtureRoot, "bin");
  const binary = Buffer.from("#!/bin/sh\nprintf '%s\\n' 'climier 2.0.0'\n", "utf8");
  const checksum = createHash("sha256").update(binary).digest("hex");
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname.endsWith("/climier-linux-x64")) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(binary);
      return;
    }
    if (pathname.endsWith("/SHA256SUMS")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`${checksum}  climier-linux-x64\n`);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run({ root: fixtureRoot, installDir, baseUrl: `http://127.0.0.1:${address.port}`, binary });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function runInstaller(env: Record<string, string>, pathPrefix?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [installer], {
      cwd: root,
      env: {
        ...process.env,
        ...env,
        PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function fakeUname(directory: string, values: string[]) {
  const command = path.join(directory, "uname");
  await writeFile(command, `#!/bin/sh\ncase "$1" in\n  -s) printf '%s\\n' '${values[0]!.replaceAll("'", "")}' ;;\n  *) printf '%s\\n' '${(values[1] ?? values[0])!.replaceAll("'", "")}' ;;\nesac\n`);
  await chmod(command, 0o755);
}

test("install.sh: downloads, verifies, installs, and leaves a working climier", async () => {
  await withFixture(async ({ root: fixtureRoot, installDir, baseUrl }) => {
    const fakeBin = path.join(fixtureRoot, "fake-bin");
    await mkdir(fakeBin);
    await fakeUname(fakeBin, ["Linux", "x86_64"]);
    const result = await runInstaller({
      CLIMIER_RELEASE_BASE_URL: baseUrl,
      CLIMIER_VERSION: "v2.0.0",
      CLIMIER_INSTALL_DIR: installDir,
    }, fakeBin);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.ok(
      result.stdout.includes(`export PATH="${installDir}:$PATH"`),
      "the installer prints the PATH line to add when the directory is not on PATH",
    );
    const version = spawnSync(path.join(installDir, "climier"), ["--version"], { encoding: "utf8" });
    assert.equal(version.status, 0);
    assert.equal(version.stdout, "climier 2.0.0\n");
  });
});

test("install.sh: rejects an invalid checksum before touching the destination", async () => {
  await withFixture(async ({ root: fixtureRoot, installDir, baseUrl, binary }) => {
    const fakeBin = path.join(fixtureRoot, "fake-bin");
    const sums = path.join(fixtureRoot, "sums");
    await mkdir(fakeBin);
    await fakeUname(fakeBin, ["Linux", "x86_64"]);
    await mkdir(installDir);
    await writeFile(path.join(installDir, "climier"), "existing installation\n");
    await writeFile(sums, `${"0".repeat(64)}  climier-linux-x64\n`);
    const result = await runInstaller({
      CLIMIER_RELEASE_BASE_URL: baseUrl,
      CLIMIER_CHECKSUM_URL: `file://${sums}`,
      CLIMIER_INSTALL_DIR: installDir,
    }, fakeBin);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /checksum/i);
    assert.equal(await readFile(path.join(installDir, "climier"), "utf8"), "existing installation\n");
    assert.equal(binary.toString(), "#!/bin/sh\nprintf '%s\\n' 'climier 2.0.0'\n");
  });
});

test("install docs: the one-line installer matches a POSIX shell", async () => {
  const [installGuide, readme, script] = await Promise.all([
    readFile(path.join(root, "docs/content/docs/getting-started/install.mdx"), "utf8"),
    readFile(path.join(root, "README.md"), "utf8"),
    readFile(installer, "utf8"),
  ]);
  assert.equal(script.split("\n", 1)[0], "#!/bin/sh");
  for (const text of [installGuide, readme]) {
    assert.match(text, /releases\/latest\/download\/install\.sh \| sh/u);
    assert.doesNotMatch(text, /install\.sh \| bash/u);
  }
});

test("install.sh: rejects Windows with manual binary installation instructions", async () => {
  await withFixture(async ({ root: fixtureRoot, baseUrl }) => {
    const fakeBin = path.join(fixtureRoot, "fake-bin");
    await mkdir(fakeBin);
    await fakeUname(fakeBin, ["MINGW64_NT-10.0"]);
    const result = await runInstaller({ CLIMIER_RELEASE_BASE_URL: baseUrl }, fakeBin);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /Windows/i);
    assert.match(`${result.stdout}${result.stderr}`, /manual|download/i);
    assert.match(`${result.stdout}${result.stderr}`, /climier-windows-x64\.exe/);
  });
});
