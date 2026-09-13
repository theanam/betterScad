/**
 * Command palette (spec feature 18).
 *
 * One registry drives both the palette and the global keyboard shortcuts, so a
 * command cannot exist with a shortcut that the palette does not list, or vice
 * versa.
 */

import { clear, el } from './dom.js';

export interface Command {
  id: string;
  title: string;
  /** Grouping label shown in the palette, e.g. "File", "View". */
  category: string;
  /** Accelerator in `Mod+K` form; `Mod` is Cmd on macOS, Ctrl elsewhere. */
  shortcut?: string;
  run(): void | Promise<void>;
  /** Hides the command when it does not currently apply. */
  enabled?(): boolean;
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function formatShortcut(shortcut: string): string {
  return shortcut
    .replace(/Mod/g, IS_MAC ? '⌘' : 'Ctrl')
    .replace(/Shift/g, IS_MAC ? '⇧' : 'Shift')
    .replace(/Alt/g, IS_MAC ? '⌥' : 'Alt')
    .replace(/\+/g, IS_MAC ? '' : '+');
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  register(command: Command): void {
    this.commands.set(command.id, command);
  }

  registerAll(commands: Command[]): void {
    for (const command of commands) this.register(command);
  }

  get all(): Command[] {
    return [...this.commands.values()];
  }

  get available(): Command[] {
    return this.all.filter((c) => c.enabled?.() !== false);
  }

  run(id: string): void {
    const command = this.commands.get(id);
    if (command && command.enabled?.() !== false) void command.run();
  }

  /**
   * Dispatches a keyboard event to a matching command.
   *
   * Returns true when a command ran, so the caller can prevent the default.
   */
  handleKey(event: KeyboardEvent): boolean {
    const pressed = describeEvent(event);
    if (!pressed) return false;
    for (const command of this.available) {
      if (!command.shortcut) continue;
      if (normalize(command.shortcut) === pressed) {
        void command.run();
        return true;
      }
    }
    return false;
  }
}

function normalize(shortcut: string): string {
  const parts = shortcut.split('+').map((p) => p.trim());
  const modifiers = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));
  const key = parts[parts.length - 1].toLowerCase();
  return [
    modifiers.has('mod') ? 'mod' : '',
    modifiers.has('shift') ? 'shift' : '',
    modifiers.has('alt') ? 'alt' : '',
    key,
  ].join('|');
}

function describeEvent(event: KeyboardEvent): string | undefined {
  const mod = IS_MAC ? event.metaKey : event.ctrlKey;
  // A bare letter is not a shortcut; function keys are.
  if (!mod && !/^F\d+$/.test(event.key) && event.key !== 'Escape') return undefined;
  return [mod ? 'mod' : '', event.shiftKey ? 'shift' : '', event.altKey ? 'alt' : '', event.key.toLowerCase()].join('|');
}

export class CommandPalette {
  private readonly dialog: HTMLDialogElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private filtered: Command[] = [];
  private selected = 0;

  constructor(private readonly registry: CommandRegistry) {
    this.input = el('input', {
      class: 'palette__input',
      type: 'text',
      placeholder: 'Type a command…',
      'aria-label': 'Command palette',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    this.list = el('ul', { class: 'palette__list', role: 'listbox' });

    this.dialog = el('dialog', { class: 'palette' }, [this.input, this.list]) as HTMLDialogElement;
    document.body.appendChild(this.dialog);

    this.input.addEventListener('input', () => this.refresh());
    this.input.addEventListener('keydown', this.onKeyDown);
    // Clicking the backdrop (outside the dialog's own box) dismisses it.
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.close();
    });
  }

  open(): void {
    this.input.value = '';
    this.selected = 0;
    this.refresh();
    if (!this.dialog.open) this.dialog.showModal();
    this.input.focus();
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.selected = Math.min(this.selected + 1, this.filtered.length - 1);
        this.paint();
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.selected = Math.max(this.selected - 1, 0);
        this.paint();
        break;
      case 'Enter': {
        event.preventDefault();
        const command = this.filtered[this.selected];
        this.close();
        if (command) void command.run();
        break;
      }
      case 'Escape':
        // Let the dialog's own Escape handling close it.
        break;
    }
  };

  private refresh(): void {
    const query = this.input.value.trim().toLowerCase();
    const commands = this.registry.available;

    this.filtered = query
      ? commands
          .map((c) => ({ command: c, score: score(`${c.category} ${c.title}`.toLowerCase(), query) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.command)
      : commands;

    this.selected = 0;
    this.paint();
  }

  private paint(): void {
    clear(this.list);

    if (this.filtered.length === 0) {
      this.list.appendChild(el('li', { class: 'panel__empty', text: 'No matching commands.' }));
      return;
    }

    this.filtered.forEach((command, index) => {
      const item = el(
        'li',
        {
          class: `palette__item${index === this.selected ? ' palette__item--selected' : ''}`,
          role: 'option',
          'aria-selected': index === this.selected,
          onclick: () => {
            this.close();
            void command.run();
          },
          onmousemove: () => {
            if (this.selected === index) return;
            this.selected = index;
            this.paint();
          },
        },
        [
          el('span', {}, [
            el('span', { class: 'palette__hint', text: `${command.category}  ` }),
            document.createTextNode(command.title),
          ]),
          command.shortcut
            ? el('span', { class: 'palette__hint', text: formatShortcut(command.shortcut) })
            : null,
        ],
      );
      this.list.appendChild(item);
      if (index === this.selected) item.scrollIntoView({ block: 'nearest' });
    });
  }
}

/**
 * Subsequence match with a bonus for contiguous runs and word starts, so
 * "epstl" finds "Export · STL".
 */
function score(text: string, query: string): number {
  let textIndex = 0;
  let total = 0;
  let streak = 0;

  for (const char of query) {
    if (char === ' ') continue;
    const found = text.indexOf(char, textIndex);
    if (found < 0) return 0;
    const atWordStart = found === 0 || text[found - 1] === ' ' || text[found - 1] === '·';
    streak = found === textIndex ? streak + 1 : 0;
    total += 1 + streak * 2 + (atWordStart ? 3 : 0);
    textIndex = found + 1;
  }
  return total;
}
