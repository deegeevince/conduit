// A name a brain wrote is never a key into a plain object: `constructor`, `toString` and `__proto__` are members of every one. Every lookup by a
// name that came from outside goes through here, or through a Map.

/** `table[key]` only when `key` is the table's own property; otherwise `fallback`. */
export function own<T>(table: Readonly<Record<string, T>>, key: string, fallback: T): T {
  return Object.hasOwn(table, key) ? (table[key] as T) : fallback;
}

/** Whether `key` is a property the table itself holds. */
export function has(table: object, key: string): boolean {
  return Object.hasOwn(table, key);
}
