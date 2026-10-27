function omittedFromObject(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function serializesAsNull(value: unknown): boolean {
  return value === null || (typeof value === "number" && !Number.isFinite(value));
}

export function structurallyEqual(a: unknown, b: unknown): boolean {
  const activePairs = new WeakMap<object, WeakSet<object>>();

  function equal(left: unknown, right: unknown, arrayItem = false): boolean {
    if (arrayItem && (omittedFromObject(left) || serializesAsNull(left)
        || omittedFromObject(right) || serializesAsNull(right))) {
      return (omittedFromObject(left) || serializesAsNull(left))
        && (omittedFromObject(right) || serializesAsNull(right));
    }
    if (serializesAsNull(left) || serializesAsNull(right)) {
      return serializesAsNull(left) && serializesAsNull(right);
    }
    if (left === right) {return true;}
    if (typeof left !== typeof right || !left || !right || typeof left !== "object") {return false;}

    const leftArray = Array.isArray(left);
    if (leftArray !== Array.isArray(right)) {return false;}
    const previous = activePairs.get(left);
    if (previous?.has(right)) {return false;}
    if (previous) { previous.add(right); }
    else { activePairs.set(left, new WeakSet([right])); }

    try {
      if (leftArray) {
        const leftValues = left as unknown[];
        const rightValues = right as unknown[];
        if (leftValues.length !== rightValues.length) {return false;}
        for (let i = 0; i < leftValues.length; i += 1) {
          if (!equal(leftValues[i], rightValues[i], true)) {return false;}
        }
        return true;
      }

      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      const leftKeys = Object.keys(leftRecord).filter((key) => !omittedFromObject(leftRecord[key])).sort();
      const rightKeys = Object.keys(rightRecord).filter((key) => !omittedFromObject(rightRecord[key])).sort();
      if (leftKeys.length !== rightKeys.length) {return false;}
      for (let i = 0; i < leftKeys.length; i += 1) {
        const key = leftKeys[i];
        if (key !== rightKeys[i] || !equal(leftRecord[key], rightRecord[key])) {return false;}
      }
      return true;
    } finally {
      activePairs.get(left)?.delete(right);
    }
  }

  return equal(a, b);
}
