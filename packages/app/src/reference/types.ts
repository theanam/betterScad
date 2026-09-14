/**
 * The shape of the reference catalogue.
 *
 * One catalogue feeds three things, which is the point of it: the Help &
 * Reference view in the app, `docs/reference.md`, and the screenshots both of
 * them show. Adding an entry here and running `npm run reference` is the whole
 * job — there is no second copy to keep in step.
 *
 * Prose fields take a deliberately tiny subset of Markdown: `code` in
 * backticks, and nothing else. The app renders it; the generated document gets
 * it for free.
 */

/** A worked example: the code, what it produces, and a picture of it. */
export interface ReferenceExample {
  /** Source, exactly as it is rendered and exactly as it is shown. */
  code: string;
  /** What the reader should notice. Shown under the picture. */
  caption?: string;
  /**
   * Screenshot id, which is also its file name: `docs/images/reference/<id>.png`.
   *
   * Omitted when the example produces no geometry — a function result, say,
   * where the answer is the console output and a picture would be a picture of
   * nothing.
   */
  image?: string;
  /** Console output, for examples whose result is text rather than a shape. */
  output?: string;
  /**
   * Camera for the screenshot. Defaults to the app's iso view.
   *
   * `plan` looks down from the front rather than the corner, which is what
   * anything with a right way up needs — the iso view's 45-degree turn about Z
   * makes a word unreadable.
   */
  view?: 'iso' | 'plan' | 'top' | 'front';
  /** Below 1 pulls the camera back; above 1 pushes in. */
  zoom?: number;
  /** Set for an example that is deliberately *not* rendered. */
  norender?: boolean;
}

/** One argument of a module or function. */
export interface ReferenceParam {
  name: string;
  description: string;
}

export interface ReferenceEntry {
  /** Stable slug: the anchor in the document and the key in the app. */
  id: string;
  /** How it is written in code — `cube()`, `$fn`, `#`. */
  name: string;
  /** Full call signature, or the syntax form for a keyword. */
  signature?: string;
  /**
   * The plain-language explanation, written for someone who has never used
   * CAD. Two or three sentences, no jargon that is not explained on the spot.
   */
  plain: string;
  /**
   * Everything the plain explanation leaves out: defaults, edge cases, the
   * exact rule. Nothing is dropped for being technical — this is where it goes.
   */
  details?: string[];
  params?: ReferenceParam[];
  examples?: ReferenceExample[];
  /** For BetterSCAD additions: what `Save as OpenSCAD .scad` writes instead. */
  downgrade?: string;
  /** Ids of related entries, shown as links. */
  see?: string[];
  /** Search terms that are not in the name — "box" finding `cube()`. */
  keywords?: string[];
  /** Marks an entry BetterSCAD adds, wherever it is listed. */
  extension?: boolean;
}

export interface ReferenceGroup {
  id: string;
  title: string;
  /** One line under the group heading. */
  blurb?: string;
  entries: ReferenceEntry[];
}

export interface ReferenceSection {
  id: string;
  title: string;
  blurb: string;
  groups: ReferenceGroup[];
}
