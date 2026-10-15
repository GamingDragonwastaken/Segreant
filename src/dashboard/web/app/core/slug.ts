/**
 * The allocation engine's id format (src/alloc/rules.ts: lowercase letters,
 * digits and . _ -, at most 64 characters), derived from a typed name. One
 * copy, so the Allocate page and the cost-centre drawer cannot derive different
 * ids from the same name.
 */
export function slug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/-+$/, '').slice(0, 64);
}
