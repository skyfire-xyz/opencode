export const titleCase = (s: string) =>
  s.replace(/(^|[-_\s])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase())
