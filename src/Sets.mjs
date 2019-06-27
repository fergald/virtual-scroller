// a - b
export function difference(a, b) {
  const result = new Set();
  for (const element of a) {
    if (!b.has(element)) {
      result.add(element);
    }
  }
  return result;
}
