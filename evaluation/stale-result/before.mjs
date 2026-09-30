export function createLoader(fetchValue) {
  let generation = 0, value;
  return {
    async load(key) {
      const current = ++generation;
      const result = await fetchValue(key);
      if (current === generation) value = result;
    },
    get value() { return value; }
  };
}
