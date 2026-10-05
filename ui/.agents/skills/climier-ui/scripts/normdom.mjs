#!/usr/bin/env node
/**
 * Normaliza dos capturas del arnés de DOM, las hashea y dice si son iguales.
 *
 *     node normdom.mjs dom/before.txt dom/after.txt
 *     node normdom.mjs --hash dom/after.txt          # sólo el hash global
 *
 * ### Qué normaliza y por qué
 *
 * - **Orden de atributos.** El orden con que el navegador serializa los atributos no es un contrato: un
 *   refactor que mueve `class` antes de `data-testid` no cambió nada visible. Se ordenan alfabéticamente.
 * - **Nodos de texto sólo-espacios.** La indentación del JSX y el reflow del código cambian los nodos de
 *   texto entre elementos. Como la normalización se aplica a **los dos** lados, ignorarlos sólo afloja la
 *   comparación, nunca la invierte. El texto con contenido se compara tal cual.
 *
 * ### Qué NO normaliza
 *
 * - El orden de los elementos, ni los elementos mismos. Mover un `<div>`, agregar un atributo o perder una
 *   clase tienen que aparecer.
 * - Los colores computados: van en su propia sección y se comparan línea por línea, en orden de documento.
 *
 * ### Las métricas no son parte del veredicto
 *
 * El renglón `-- metrics` tiene contadores (elementos, pintados, svgs) y la URL. Son **informativos**: se
 * imprimen lado a lado para diagnosticar, pero no entran en el hash. `painted` depende de que las fuentes ya
 * hayan cargado, así que puede oscilar entre corridas y no debe decidir nada. El veredicto lo dan el markup y
 * los colores.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [, , ...args] = process.argv;
const onlyHash = args[0] === "--hash";
const paths = onlyHash ? args.slice(1) : args;

if (paths.length !== (onlyHash ? 1 : 2)) {
  console.error("uso: normdom.mjs <base> <nuevo>   |   normdom.mjs --hash <archivo>");
  process.exit(2);
}

const TAG = /^<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>$/;
const ATTR = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;

/** Ordena los atributos de cada etiqueta y descarta los nodos de texto que son sólo espacios. */
function normalizeMarkup(markup) {
  return markup
    .split(/(?=<)|(?<=>)/)
    .map((token) => {
      const match = token.match(TAG);
      if (!match) return /\S/.test(token) ? token : "";
      const attrs = (match[2].match(ATTR) ?? []).map((attr) => attr.trim()).sort();
      return `<${match[1]}${attrs.length ? " " + attrs.join(" ") : ""}${match[3]}>`;
    })
    .join("");
}

function splitBlocks(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("##########")) {
      current = { name: line.slice("##########".length).trim(), metrics: [], colors: [], dom: [] };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("-- metrics")) current.metrics.push(line.slice("-- metrics".length).trim());
    else if (line.startsWith("-- colors")) current.section = "colors";
    else if (line.startsWith("-- dom")) current.section = "dom";
    else if (current.section === "colors" && line.trim()) current.colors.push(line.trim().replace(/\s+/g, " "));
    else if (current.section === "dom") current.dom.push(line);
  }
  return blocks;
}

const hash = (value) => createHash("sha256").update(value).digest("hex");

/** El hash de un bloque cubre markup normalizado + colores. Las métricas quedan afuera a propósito. */
function blockDigest(block) {
  return hash(`${normalizeMarkup(block.dom.join("\n"))}\n${block.colors.join("\n")}`);
}

const read = (path) => splitBlocks(readFileSync(path, "utf8"));
const digestOf = (blocks) => hash(blocks.map((block) => `${block.name}\n${blockDigest(block)}`).join("\n"));

if (onlyHash) {
  const blocks = read(paths[0]);
  const bytes = readFileSync(paths[0]).length;
  console.log(`${paths[0]}  ${bytes} bytes  ${blocks.length} bloques  sha256: ${digestOf(blocks)}`);
  process.exit(0);
}

const [basePath, newPath] = paths;
const base = read(basePath);
const updated = read(newPath);

for (const [label, path, blocks] of [
  ["BASE ", basePath, base],
  ["NUEVO", newPath, updated],
]) {
  console.log(`  ${label}  ${readFileSync(path).length} bytes  ${String(blocks.length).padStart(2)} bloques  sha256: ${digestOf(blocks)}`);
}
console.log();

if (base.length !== updated.length) {
  console.error(`  Los archivos tienen distinta cantidad de capturas: ${base.length} vs ${updated.length}`);
  process.exit(1);
}

const changed = [];
for (let index = 0; index < base.length; index += 1) {
  if (blockDigest(base[index]) !== blockDigest(updated[index])) changed.push(index);
}

if (changed.length === 0) {
  console.log("╔════════════════════════════════════════════════════════╗");
  console.log("║  IDÉNTICO — 0 cambios de render ni de interacción      ║");
  console.log("╚════════════════════════════════════════════════════════╝");
  process.exit(0);
}

console.log(`DIFERENCIAS — ${changed.length} de ${base.length} capturas\n`);
for (const index of changed) {
  const before = base[index];
  const after = updated[index];
  console.log(`=== ${before.name} ===`);
  console.log(`  métricas (informativas)  base : ${before.metrics.join(" ")}`);
  console.log(`  métricas (informativas)  nuevo: ${after.metrics.join(" ")}`);

  const sections = [
    ["colores", before.colors, after.colors],
    ["markup", normalizeMarkup(before.dom.join("\n")).split(/(?=<)/), normalizeMarkup(after.dom.join("\n")).split(/(?=<)/)],
  ];
  for (const [label, left, right] of sections) {
    if (left.join("\n") === right.join("\n")) continue;
    const size = Math.max(left.length, right.length);
    let shown = 0;
    for (let line = 0; line < size && shown < 8; line += 1) {
      if (left[line] === right[line]) {
        // Con listas de distinto largo, un hueco corre todo lo que sigue. Se busca el token perdido para no
        // reportar cien diferencias falsas a partir de una inserción.
        if (left[line] === undefined || right[line] === undefined) {
          console.log(`  ${label}  base : ${left[line] === undefined ? "(vacío)" : left[line].slice(0, 300)}`);
          console.log(`  ${label}  nuevo: ${right[line] === undefined ? "(vacío)" : right[line].slice(0, 300)}`);
          shown += 1;
        }
        continue;
      }
      console.log(`  ${label}  base : ${left[line] === undefined ? "(vacío)" : left[line].slice(0, 300)}`);
      console.log(`  ${label}  nuevo: ${right[line] === undefined ? "(vacío)" : right[line].slice(0, 300)}`);
      shown += 1;
    }
    if (shown === 8) console.log(`  ${label}  … (hay más; subí el límite si hace falta)`);
  }
  console.log();
}
console.log("Cada diferencia tiene que ser intencional y estar explicada. Si no lo es, es un bug del refactor.");
process.exit(1);
