import { BOOLEAN_FLAGS } from "./dispatch-constants.ts";

function parsedFlag(argv: string[], index: number): { key: string; value: string | boolean | undefined; nextIndex: number } {
  const token = argv[index];
  const equalsIndex = token.indexOf("=");
  if (equalsIndex !== -1) {
    return { key: token.slice(2, equalsIndex), value: token.slice(equalsIndex + 1), nextIndex: index };
  }
  const key = token.slice(2);
  const next = argv[index + 1];
  const consumesNext = !BOOLEAN_FLAGS.has(key) && next !== undefined && !String(next).startsWith("--");
  return { key, value: consumesNext ? next : true, nextIndex: consumesNext ? index + 1 : index };
}

export function parseArgv(argv: string[] = []): { originalArgv: string[]; command: string | null; flags: Record<string, string | boolean | undefined>; positional: string[] } {
  const originalArgv = Array.isArray(argv) ? argv.slice() : [];
  const flags: Record<string, string | boolean | undefined> = {};
  const positional: string[] = [];
  let command: string | null = null;
  let parsingCommand = false;

  for (let i = 0; i < originalArgv.length; i++) {
    const token = originalArgv[i];
    if (typeof token !== "string") {
      continue;
    }
    if (token.startsWith("--")) {
      const parsed = parsedFlag(originalArgv, i);
      flags[parsed.key] = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (!parsingCommand) {
      command = token;
      parsingCommand = true;
      continue;
    }
    positional.push(token);
  }

  return { originalArgv, command, flags, positional };
}

export function formatOutput(value) {
  return JSON.stringify(value, null, 2);
}

export function formatError(error) {
  return formatOutput({ ok: false, error });
}
