import assert from "node:assert/strict";
import test from "node:test";
import { structurallyEqual } from "../src/contracts/structural-equality.ts";
import { deepEqualNodes } from "../src/kernel/mutation/revisions.ts";

test("structural equality matches JSON omission and array-null behavior", () => {
  const equivalentPairs = [
    [{ value: undefined }, {}],
    [{ nested: { value: undefined, keep: [1, { flag: true }] } }, { nested: { keep: [1, { flag: true }] } }],
    [[undefined, { nested: ["x", undefined] }], [null, { nested: ["x", null] }]],
    [{ first: 1, second: { list: [1, 2] } }, { first: 1, second: { list: [1, 2] } }],
  ];

  for (const [left, right] of equivalentPairs) {
    assert.equal(JSON.stringify(left), JSON.stringify(right));
    assert.equal(structurallyEqual(left, right), true);
  }
});

test("structural equality ignores object key order but preserves array order", () => {
  assert.equal(structurallyEqual({ first: 1, second: 2 }, { second: 2, first: 1 }), true);
  assert.equal(structurallyEqual({ nested: { value: 1 } }, { nested: { value: 2 } }), false);
  assert.equal(structurallyEqual([1, 2], [2, 1]), false);
});

test("node equality preserves primitive comparison and ignores undefined-valued fields", () => {
  assert.equal(deepEqualNodes({ id: "T1", meta: { optional: undefined } }, { id: "T1", meta: {} }), true);
  assert.equal(deepEqualNodes({ id: "T1", value: null }, { id: "T1", value: Number.NaN }), false);
});

