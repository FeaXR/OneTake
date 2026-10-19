export type Params = Record<string, string | number>;

/** A plain string with {placeholders}, or a function for wording that depends on numbers (plurals). */
export type Message = string | ((p: Params) => string);
