export async function useResource(open, work) {
  const resource = await open();
  try {
    const result = await work(resource);
    return result;
  } finally { await resource.close(); }
}
