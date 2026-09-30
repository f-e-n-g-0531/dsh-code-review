export async function useResource(open, work) {
  const resource = await open();
  const result = await work(resource);
  await resource.close();
  return result;
}
