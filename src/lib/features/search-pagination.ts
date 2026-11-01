export const SEARCH_PAGE_SIZE = 30;

/** Keep rendering bounded while leaving every ranked match reachable. */
export function paginateSearchResults<T>(results: T[], visibleCount: number): { visible: T[]; remaining: number } {
  const count = Math.max(0, Math.floor(visibleCount));
  return { visible: results.slice(0, count), remaining: Math.max(0, results.length - count) };
}
