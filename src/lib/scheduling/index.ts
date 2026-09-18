/**
 * The sport-agnostic scheduling core.
 *
 * Nothing under `src/lib/scheduling/` may import a tournament-domain module: this package operates
 * only on generic matches, participants, dependencies, resources, constraints and objectives, and
 * the formats, sport rules, venue configuration and scheduling policy are supplied from outside.
 */

export * from "./domain";
export * from "./time";
export * from "./constraints";
export * from "./preflight";
export * from "./metrics";
export * from "./solvers/types";
export * from "./solvers";
export * from "./providers";
export * from "./formats/types";
