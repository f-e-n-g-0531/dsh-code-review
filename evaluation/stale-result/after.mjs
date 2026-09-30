export function createLoader(fetchValue) {
  let value;
  return {
    async load(key) {
      const result = await fetchValue(key);
      value = result;
    },
    get value() { return value; }
  };
}
