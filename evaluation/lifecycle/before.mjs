export async function useResource(open, work) {
  const resource = await open();
  try { return await work(resource); }
  finally { await resource.close(); }
}
