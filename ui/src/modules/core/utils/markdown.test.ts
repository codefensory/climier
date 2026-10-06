import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

describe("parseInline", () => {
  it("corta el texto y resuelve negrita, cursiva, tachado y código", () => {
    expect(parseInline("a **b** _c_ ~~d~~ `e`")).toEqual([
      { type: "text", value: "a " },
      { type: "strong", children: [{ type: "text", value: "b" }] },
      { type: "text", value: " " },
      { type: "em", children: [{ type: "text", value: "c" }] },
      { type: "text", value: " " },
      { type: "del", children: [{ type: "text", value: "d" }] },
      { type: "text", value: " " },
      { type: "code", value: "e" },
    ]);
  });

  it("no interpreta snake_case como cursiva", () => {
    expect(parseInline("run add_node --as alice")).toEqual([{ type: "text", value: "run add_node --as alice" }]);
  });

  it("acepta links http/https/mailto y anida inline en la etiqueta", () => {
    expect(parseInline("see [the **doc**](https://example.com/x)")).toEqual([
      { type: "text", value: "see " },
      {
        type: "link",
        href: "https://example.com/x",
        children: [{ type: "text", value: "the " }, { type: "strong", children: [{ type: "text", value: "doc" }] }],
      },
    ]);
  });

  it("deja un link inseguro como texto plano", () => {
    expect(parseInline("[x](javascript:alert(1))")).toEqual([
      { type: "text", value: "[x](javascript:alert(1))" },
    ]);
  });

  it("respeta el escape de delimitadores", () => {
    expect(parseInline("\\*not italic\\*")).toEqual([{ type: "text", value: "*not italic*" }]);
  });
});

describe("parseMarkdown", () => {
  it("separa párrafos por línea en blanco y une saltos suaves con espacio", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "one two" }] },
      { type: "paragraph", children: [{ type: "text", value: "three" }] },
    ]);
  });

  it("parsea títulos con su nivel", () => {
    expect(parseMarkdown("## Title")).toEqual([
      { type: "heading", level: 2, children: [{ type: "text", value: "Title" }] },
    ]);
  });

  it("agrupa listas y distingue ordenadas de viñetas", () => {
    expect(parseMarkdown("- a\n- b\n\n1. c\n2. d")).toEqual([
      { type: "list", ordered: false, items: [[{ type: "text", value: "a" }], [{ type: "text", value: "b" }]] },
      { type: "list", ordered: true, items: [[{ type: "text", value: "c" }], [{ type: "text", value: "d" }]] },
    ]);
  });

  it("toma el fence de código con su lenguaje y no lo interpreta", () => {
    expect(parseMarkdown("```ts\nconst x = **1**;\n```")).toEqual([
      { type: "code", lang: "ts", value: "const x = **1**;" },
    ]);
  });

  it("parsea citas y reglas", () => {
    expect(parseMarkdown("> quote\n\n---")).toEqual([
      { type: "quote", children: [{ type: "text", value: "quote" }] },
      { type: "hr" },
    ]);
  });

  it("no interpreta HTML crudo: sale como texto del párrafo", () => {
    expect(parseMarkdown("<script>alert(1)</script>")).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "<script>alert(1)</script>" }] },
    ]);
  });

  it("devuelve vacío para entrada vacía o ausente", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n  \n")).toEqual([]);
  });
});
