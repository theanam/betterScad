/**
 * How a file's BetterSCAD extensions are listed.
 *
 * Shared by the Info panel, the warning shown when a `.scad` turns out not to
 * be stock, and the Save-as-OpenSCAD confirmation — three places that answer
 * the same question and so should answer it the same way.
 */

import type { ExtensionUse } from '@betterscad/engine';
import { el } from './dom.js';

/** `name — what it becomes`, with the lines it appears on. */
export function extensionList(extensions: ExtensionUse[]): HTMLElement {
  return el(
    'ul',
    { class: 'extensionlist' },
    extensions.map((use) =>
      el('li', {}, [
        el('code', { text: use.name }),
        document.createTextNode(` — ${use.downgrade}`),
        el('span', { class: 'extensionlist__where', text: formatLines(use.lines) }),
      ]),
    ),
  );
}

/** "line 4" / "lines 4, 9" / "lines 4, 9, 12, 20 +3 more". */
export function formatLines(lines: number[]): string {
  if (lines.length === 0) return '';
  const shown = lines.slice(0, 4).join(', ');
  const more = lines.length > 4 ? ` +${lines.length - 4} more` : '';
  return `  line${lines.length === 1 ? '' : 's'} ${shown}${more}`;
}
