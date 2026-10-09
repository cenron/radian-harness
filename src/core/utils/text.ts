/** "a, b, c, and 2 more": the first `limit` items, then a count of the rest. */
export function listSome(items: readonly string[], limit: number): string {
  const listed = items.slice(0, limit).join(", ");
  const more = items.length - limit;
  return more > 0 ? `${listed}, and ${more} more` : listed;
}
