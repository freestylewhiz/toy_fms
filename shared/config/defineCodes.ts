/** Defines a finite wire-code catalog and its presentation labels. */
export function defineCodes<const T extends Record<string, string>>(codes: T) {
  const labels = Object.freeze(Object.assign(Object.create(null), codes)) as Readonly<T>;
  const values = Object.freeze(Object.keys(labels) as (keyof T & string)[]);
  const code = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(values.map((value) => [value, value])))) as { readonly [K in keyof T]: K };
  const options = Object.freeze(values.map((value) => Object.freeze({ value, label: labels[value] })));
  const valueSet = new Set<string>(values);
  return Object.freeze({
    values,
    code,
    labels,
    options,
    is(value: unknown): value is keyof T & string {
      return typeof value === "string" && valueSet.has(value);
    },
  });
}

export type CodeOf<T extends { values: readonly string[] }> = T["values"][number];
