/**
 * Customizer panel (spec feature 8).
 *
 * Builds controls from the parameter annotations the engine extracts, and
 * re-renders live as they change. Slider drags emit continuously; the render
 * client coalesces them, so the preview tracks the handle instead of lagging
 * behind a queue.
 */

import type { CustomizerModel, CustomizerParameter, Value } from '@betterscad/engine';
import { button, clear, el, formatNumber, icon } from './dom.js';
import { setHint } from './tooltip.js';

export interface CustomizerCallbacks {
  onChange(name: string, value: Value): void;
  onReset(): void;
  onApplyToSource(): void;
  /** Hides the panel. Same state the toolbar's Customizer button toggles. */
  onClose(): void;
}

export class CustomizerPanel {
  readonly element: HTMLElement;
  private readonly body: HTMLElement;
  private model: CustomizerModel = { parameters: [], groups: [] };
  private values: Record<string, Value> = {};
  /** Group open/closed state, kept across re-renders so editing is not jarring. */
  private readonly collapsed = new Set<string>();

  constructor(private readonly callbacks: CustomizerCallbacks) {
    this.body = el('div', { class: 'panel__body customizer' });

    this.element = el('div', { class: 'panel' }, [
      el('div', { class: 'panel__header' }, [
        el('span', { text: 'Customizer' }),
        el('span', { class: 'toolbar__spacer' }),
        button({
          label: 'Reset',
          title: 'Restore every parameter to the value in the script',
          onClick: () => this.callbacks.onReset(),
        }),
        button({
          label: 'Apply to script',
          title: 'Write the current values back into the source',
          onClick: () => this.callbacks.onApplyToSource(),
        }),
        closeButton(() => this.callbacks.onClose()),
      ]),
      this.body,
    ]);
  }

  /**
   * Updates the control set.
   *
   * Rebuilding wholesale would steal focus mid-edit, so the panel only rebuilds
   * when the parameter *shape* changes; otherwise it just refreshes values.
   */
  update(model: CustomizerModel, values: Record<string, Value>): void {
    const signature = (m: CustomizerModel): string =>
      m.parameters.map((p) => `${p.name}:${p.kind}:${p.group}:${p.min}:${p.max}:${p.step}`).join('|');

    const changed = signature(model) !== signature(this.model);
    this.model = model;
    this.values = values;
    if (changed) this.render();
    else this.refreshValues();
  }

  private valueOf(param: CustomizerParameter): Value {
    return param.name in this.values ? this.values[param.name] : param.defaultValue;
  }

  private render(): void {
    clear(this.body);

    if (this.model.parameters.length === 0) {
      this.body.appendChild(
        el('div', { class: 'panel__empty' }, [
          el('p', { text: 'No customizable parameters in this script.' }),
          el('p', {
            class: 'param__hint',
            text: 'Add a top-level assignment with a literal value, optionally annotated: size = 20; // [10:50]',
          }),
        ]),
      );
      return;
    }

    for (const group of this.model.groups) {
      const parameters = this.model.parameters.filter((p) => p.group === group);
      if (parameters.length === 0) continue;

      const details = el('details', {
        class: 'customizer__group',
        open: !this.collapsed.has(group),
      });
      details.addEventListener('toggle', () => {
        if (details.open) this.collapsed.delete(group);
        else this.collapsed.add(group);
      });
      details.appendChild(el('summary', { text: group }));
      for (const param of parameters) details.appendChild(this.buildControl(param));
      this.body.appendChild(details);
    }
  }

  /** Re-reads values into the existing inputs without rebuilding the DOM. */
  private refreshValues(): void {
    for (const param of this.model.parameters) {
      const value = this.valueOf(param);
      const inputs = this.body.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        `[data-param="${CSS.escape(param.name)}"]`,
      );
      for (const input of inputs) {
        // Never fight the control the user is currently holding.
        if (document.activeElement === input) continue;
        if (input instanceof HTMLInputElement && input.type === 'checkbox') {
          input.checked = value === true;
        } else if (param.kind === 'vector' && input.dataset.index !== undefined) {
          const component = Array.isArray(value) ? value[Number(input.dataset.index)] : 0;
          input.value = String(component ?? 0);
        } else {
          input.value = String(value ?? '');
        }
      }
      const readout = this.body.querySelector<HTMLElement>(
        `[data-readout="${CSS.escape(param.name)}"]`,
      );
      if (readout && typeof value === 'number') readout.textContent = formatNumber(value, 3);
    }
  }

  private buildControl(param: CustomizerParameter): HTMLElement {
    const value = this.valueOf(param);
    const row = el('div', { class: 'param' });

    const readout = el('span', {
      class: 'param__value',
      'data-readout': param.name,
      text: typeof value === 'number' ? formatNumber(value, 3) : '',
    });

    row.appendChild(
      el('label', { class: 'param__label' }, [
        el('span', { class: 'param__name', text: param.name }),
        param.kind === 'slider' || param.kind === 'number' ? readout : null,
      ]),
    );

    if (param.description) {
      row.appendChild(el('span', { class: 'param__hint', text: param.description }));
    }

    row.appendChild(this.buildInput(param, value, readout));
    return row;
  }

  private buildInput(param: CustomizerParameter, value: Value, readout: HTMLElement): HTMLElement {
    const emit = (next: Value): void => this.callbacks.onChange(param.name, next);

    switch (param.kind) {
      case 'checkbox': {
        const input = el('input', {
          type: 'checkbox',
          'data-param': param.name,
          checked: value === true,
          oninput: ((event: Event) => emit((event.target as HTMLInputElement).checked)) as EventListener,
        });
        return el('div', { class: 'param__row' }, [input]);
      }

      case 'slider': {
        const step = param.step ?? inferStep(param.min ?? 0, param.max ?? 100);
        const slider = el('input', {
          type: 'range',
          'data-param': param.name,
          min: String(param.min ?? 0),
          max: String(param.max ?? 100),
          step: String(step),
          value: String(value ?? 0),
          oninput: ((event: Event) => {
            const next = Number((event.target as HTMLInputElement).value);
            readout.textContent = formatNumber(next, 3);
            emit(next);
          }) as EventListener,
        });
        const number = el('input', {
          type: 'number',
          'data-param': param.name,
          min: String(param.min ?? ''),
          max: String(param.max ?? ''),
          step: String(step),
          value: String(value ?? 0),
          oninput: ((event: Event) => {
            const next = Number((event.target as HTMLInputElement).value);
            if (!Number.isFinite(next)) return;
            slider.value = String(next);
            readout.textContent = formatNumber(next, 3);
            emit(next);
          }) as EventListener,
        });
        return el('div', { class: 'param__row' }, [slider, number]);
      }

      case 'number': {
        const input = el('input', {
          type: 'number',
          'data-param': param.name,
          step: String(param.step ?? 'any'),
          max: param.max !== undefined ? String(param.max) : undefined,
          value: String(value ?? 0),
          oninput: ((event: Event) => {
            const next = Number((event.target as HTMLInputElement).value);
            if (Number.isFinite(next)) {
              readout.textContent = formatNumber(next, 3);
              emit(next);
            }
          }) as EventListener,
        });
        return el('div', { class: 'param__row' }, [input]);
      }

      case 'text': {
        const input = el('input', {
          type: 'text',
          'data-param': param.name,
          maxlength: param.maxLength !== undefined ? String(param.maxLength) : undefined,
          value: String(value ?? ''),
          oninput: ((event: Event) => emit((event.target as HTMLInputElement).value)) as EventListener,
        });
        return el('div', { class: 'param__row' }, [input]);
      }

      case 'dropdown': {
        const select = el('select', {
          'data-param': param.name,
          oninput: ((event: Event) => {
            const index = (event.target as HTMLSelectElement).selectedIndex;
            emit(param.options?.[index]?.value);
          }) as EventListener,
        });
        for (const option of param.options ?? []) {
          const node = el('option', { text: option.label, value: String(option.value) });
          if (option.value === value) node.selected = true;
          select.appendChild(node);
        }
        return el('div', { class: 'param__row' }, [select]);
      }

      case 'vector': {
        const size = param.size ?? 3;
        const current = Array.isArray(value) ? value : new Array(size).fill(0);
        const labels = ['x', 'y', 'z', 'w'];
        const inputs = el('div', { class: 'param__vector' });

        for (let i = 0; i < size; i++) {
          inputs.appendChild(
            el('input', {
              type: 'number',
              'data-param': param.name,
              'data-index': String(i),
              'aria-label': `${param.name} ${labels[i] ?? i}`,
              step: String(param.step ?? 'any'),
              value: String(current[i] ?? 0),
              oninput: ((event: Event) => {
                const input = event.target as HTMLInputElement;
                const next = [...(Array.isArray(this.valueOf(param)) ? (this.valueOf(param) as Value[]) : current)];
                next[i] = Number(input.value);
                emit(next);
              }) as EventListener,
            }),
          );
        }
        return inputs;
      }

      default:
        return el('div', { class: 'param__hint', text: 'Unsupported parameter type.' });
    }
  }
}

/** A step fine enough to be useful across the range, but not absurdly fine. */
function inferStep(min: number, max: number): number {
  const span = Math.abs(max - min);
  if (span === 0) return 1;
  if (span <= 2) return 0.01;
  if (span <= 20) return 0.1;
  if (span <= 200) return 1;
  return Math.pow(10, Math.floor(Math.log10(span)) - 2);
}

/**
 * The panel's own way out.
 *
 * The toolbar's Customizer button already toggles this panel, but a control
 * that opens something from across the window is a poor way to close it: the
 * thing you want gone is right here. Last in the header, where a dismiss
 * belongs, and after the actions so it is not in the way of them.
 */
function closeButton(onClose: () => void): HTMLButtonElement {
  const node = el('button', {
    class: 'panel__close',
    type: 'button',
    onclick: () => onClose(),
  }) as HTMLButtonElement;
  node.appendChild(icon('close', 18));
  setHint(node, 'Hide the Customizer');
  return node;
}
