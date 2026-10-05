/**
 * Forma de un asset de Hugeicons: una lista de tuplas `[tag, atributos]`.
 *
 * No se importa del paquete porque `IconSvgObject` está declarado **sin** `export` en
 * `@hugeicons/core-free-icons/dist/types/index.d.ts`, y el mapa `exports` del paquete no expone
 * el módulo de tipos.
 *
 * Si el paquete cambiara la forma, `tsc` lo detecta igual: los assets dejarían de ser asignables
 * a este tipo en cada call site.
 */
export type HugeIconAsset =
  | [string, { [key: string]: string | number }][]
  | readonly (readonly [string, { readonly [key: string]: string | number }])[];
