// Stands in for app/src/lib/format.ts imports made from app components (see
// remotion.config.ts): the real formatters, except the quote countdown, which
// is frozen so frames rendered in parallel never disagree about the time.

export * from "../../../app/src/lib/format.ts";

export function countdown(): string {
  return "14:32";
}
