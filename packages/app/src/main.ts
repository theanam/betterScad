/**
 * Application entry point.
 *
 * Wires the editor, viewport, panels and render worker together, and owns the
 * single source of truth for what is on screen. Deliberately imperative: the
 * app is a handful of long-lived panels, and the state that actually changes
 * often (geometry) never goes through the DOM at all.
 */

import {
  ENGINE_VERSION,
  applyParametersToSource,
  describeExtensions,
  parse,
  transpileToLegacyScad,
  type CustomizerModel,
  type Diagnostic,
  type ExtensionUse,
  type Value,
} from '@betterscad/engine';

import { ScadEditor } from './editor/editor.js';
import {
  BUNDLED_FONTS,
  DEFAULT_FAMILY,
  cachedFontBytes,
  clearFontCache,
  fetchBundledFont,
  fetchCatalogFont,
  loadCatalog,
  querySystemFonts,
  type CatalogEntry,
} from './files/font-library.js';
import {
  fileAccessMode,
  openBinaryFiles,
  openFontFiles,
  openScadFiles,
  saveBinaryAs,
  saveTextAs,
  writeToHandle,
} from './files/fs-access.js';
import { RenderClient } from './render/client.js';
import type { RenderResponse, RenderStats } from './render/protocol.js';
import {
  STARTER_DOCUMENT,
  Workspace,
  withFormatExtension,
  type Document,
  type DocumentFormat,
} from './state/workspace.js';
import { AnimationBar, StatusBar, TabStrip, Toasts, Toolbar } from './ui/chrome.js';
import { CommandPalette, CommandRegistry } from './ui/command-palette.js';
import { ConsolePanel } from './ui/console-panel.js';
import { CustomizerPanel } from './ui/customizer-panel.js';
import {
  showAboutDialog,
  showConfirm,
  showExportDialog,
  showFontDialog,
  showLegacyExportDialog,
  showNonStandardSyntaxDialog,
  type NonStandardFile,
} from './ui/dialogs.js';
import { announce, button, clear, debounce, el, formatNumber } from './ui/dom.js';
import { Split } from './ui/layout.js';
import { Viewport } from './viewport/viewport.js';

class App {
  private readonly workspace = new Workspace();
  private readonly registry = new CommandRegistry();
  private readonly toasts = new Toasts();
  /** Font bytes that never reach the download cache: bundled, disk and system faces. */
  private readonly localFontBytes = new Map<string, Uint8Array>();

  private editor!: ScadEditor;
  private viewport!: Viewport;
  private client!: RenderClient;
  private palette!: CommandPalette;

  private toolbar!: Toolbar;
  private tabs!: TabStrip;
  private statusBar!: StatusBar;
  private consolePanel!: ConsolePanel;
  private customizerPanel!: CustomizerPanel;
  private animationBar?: AnimationBar;

  private mainSplit!: Split;
  private rightSplit!: Split;
  private customizerHost!: HTMLElement;
  private animationHost!: HTMLElement;
  private busyBadge!: HTMLElement;
  private measureReadout!: HTMLElement;

  private cursor = { line: 1, column: 1 };
  private lastStats: RenderStats | undefined;
  private lastDimension: 2 | 3 | 0 = 0;
  /** Whether what is on screen came from a full render rather than a preview. */
  private showingFinalRender = false;
  private customizerModel: CustomizerModel = { parameters: [], groups: [] };
  private fontFamilies: string[] = [];
  private fontFaces: { family: string; style: string }[] = [];
  private catalog: CatalogEntry[] = [];
  private animationTime = 0;
  /** True until the first render completes, so the boot screen can stay up. */
  private booting = true;

  private readonly scheduleRender = debounce(() => void this.render(true), 320);

  // -- boot -----------------------------------------------------------------

  async start(): Promise<void> {
    if (!this.workspace.restore()) {
      this.workspace.createDocument('model.bscad', STARTER_DOCUMENT);
    }
    this.applyTheme(this.workspace.layout.theme);

    this.buildUi();
    this.registerCommands();

    this.client = new RenderClient(
      (result) => this.onRenderResult(result),
      (message) => this.reportError(message),
    );

    await this.client.ready;
    await this.loadBundledFonts();

    this.refreshChrome();
    await this.render(false);

    this.finishBoot();
    this.registerServiceWorker();
    this.installGlobalHandlers();
  }

  private finishBoot(): void {
    this.booting = false;
    document.getElementById('boot')?.remove();
    const app = document.getElementById('app');
    if (app) app.hidden = false;
    // The viewport was sized while hidden, so it needs one explicit resize.
    this.viewport.resize();
    this.viewport.frameAll();
    this.editor.focus();
  }

  // -- UI construction ------------------------------------------------------

  private buildUi(): void {
    const root = document.getElementById('app');
    if (!root) throw new Error('Missing #app element.');
    clear(root);

    this.toolbar = new Toolbar({
      newFile: () => this.newDocument(),
      open: () => void this.openFiles(),
      save: () => void this.save(),
      saveAs: (format) => void this.saveAs(format),
      preview: () => void this.render(true),
      render: () => void this.render(false),
      export: () => void this.exportModel(),
      toggleCustomizer: () => this.toggleCustomizer(),
      toggleConsole: () => this.toggleConsole(),
      toggleTheme: () => this.toggleTheme(),
      openPalette: () => this.palette.open(),
      openFonts: () => void this.openFontManager(),
    });

    this.tabs = new TabStrip(
      (id) => this.selectDocument(id),
      (id) => void this.closeDocument(id),
      () => this.newDocument(),
    );

    // --- editor column ---
    const editorHost = el('div', { class: 'editor' });
    this.customizerPanel = new CustomizerPanel({
      onChange: (name, value) => this.setParameter(name, value),
      onReset: () => this.resetParameters(),
      onApplyToSource: () => this.applyParametersToSource(),
    });
    this.customizerHost = el('div', { style: 'display:none; flex: 0 0 42%; min-height:0;' }, [
      this.customizerPanel.element,
    ]);

    // --- viewport column ---
    const viewportHost = el('div', { class: 'viewport' });
    this.busyBadge = el('div', { class: 'viewport__busy', text: 'Rendering…', style: 'display:none' });
    this.measureReadout = el('div', { class: 'viewport__measure', style: 'display:none' });
    const hud = el('div', { class: 'viewport__hud' });
    this.animationHost = el('div', {});

    viewportHost.append(
      el('div', { class: 'viewport__overlay' }, [
        this.busyBadge,
        this.measureReadout,
        hud,
        ...this.buildViewTools(),
      ]),
    );

    this.consolePanel = new ConsolePanel((line, column) => this.editor.goTo(line, column));

    this.rightSplit = new Split({
      orientation: 'horizontal',
      initialFraction: 1 - this.workspace.layout.consoleFraction,
      minFraction: 0.2,
      maxFraction: 0.95,
      onResize: (fraction) => {
        this.workspace.layout.consoleFraction = 1 - fraction;
        this.workspace.persist();
        this.viewport.resize();
      },
    });
    this.rightSplit.first.append(viewportHost, this.animationHost);
    this.rightSplit.second.append(this.consolePanel.element);

    this.mainSplit = new Split({
      orientation: 'vertical',
      initialFraction: this.workspace.layout.editorFraction,
      onResize: (fraction) => {
        this.workspace.layout.editorFraction = fraction;
        this.workspace.persist();
        this.viewport.resize();
      },
    });
    this.mainSplit.first.classList.add('pane--editor');
    this.mainSplit.first.append(this.tabs.element, editorHost, this.customizerHost);
    this.mainSplit.second.append(this.rightSplit.element);

    this.statusBar = new StatusBar(() => {
      this.workspace.layout.autoRender = !this.workspace.layout.autoRender;
      this.workspace.persist();
      this.refreshChrome();
    });

    root.append(this.toolbar.element, this.mainSplit.element, this.statusBar.element);

    // --- live components, created after they have a sized host ---
    this.editor = new ScadEditor(editorHost, this.workspace.active?.text ?? '', {
      onChange: (source) => this.onSourceChanged(source),
      onCursor: (line, column) => {
        this.cursor = { line, column };
        this.refreshChrome();
      },
      onShortcut: (name) => this.runShortcut(name),
    });

    this.viewport = new Viewport(viewportHost, {
      onMeasure: (measurement) => this.showMeasurement(measurement),
    });
    this.viewport.controls.apply();

    // The HUD tracks the camera, which changes far more often than anything
    // else on screen, so it updates directly rather than through refreshChrome.
    const paintHud = (): void => {
      const vp = this.viewport.controls.viewportVariables;
      hud.replaceChildren(
        el('span', { text: `$vpd ${formatNumber(vp.distance, 1)}` }),
        el('span', {
          text: `$vpr [${vp.rotation.map((n) => formatNumber(n, 0)).join(', ')}]`,
        }),
      );
    };
    paintHud();
    viewportHost.addEventListener('pointermove', paintHud);
    viewportHost.addEventListener('wheel', paintHud, { passive: true });

    this.palette = new CommandPalette(this.registry);
    this.applyLayoutVisibility();
  }

  /**
   * Viewport overlay controls.
   *
   * Named views used to live in a button stack; the view cube replaces them and
   * shows the current orientation besides. What is left are the two things the
   * cube cannot express — reset and fit — tucked directly beneath it, and the
   * two display toggles, moved out of the way to the opposite corner. Every
   * named view is still reachable from the command palette.
   */
  private buildViewTools(): HTMLElement[] {
    const displayTools = el('div', { class: 'viewport__tools viewport__tools--topleft' });

    const gridButton = button({
      iconName: 'grid',
      title: 'Toggle the ground grid',
      onClick: () => {
        this.workspace.layout.showGrid = !this.workspace.layout.showGrid;
        this.viewport.setHelperVisibility({ grid: this.workspace.layout.showGrid });
        gridButton.classList.toggle('btn--active', this.workspace.layout.showGrid);
        this.workspace.persist();
      },
    });
    gridButton.classList.toggle('btn--active', this.workspace.layout.showGrid);

    const measureButton = button({
      iconName: 'ruler',
      title: 'Measure — click points on the model for coordinates and distances',
      onClick: () => {
        const active = !this.viewport.measuring;
        this.viewport.setMeasuring(active);
        measureButton.classList.toggle('btn--active', active);
        if (!active) this.measureReadout.style.display = 'none';
      },
    });

    displayTools.append(gridButton, measureButton);

    // Sits under the cube, so the camera controls are all in one place.
    const cameraTools = el('div', { class: 'viewport__tools viewport__tools--gizmo' }, [
      button({
        iconName: 'reset',
        title: 'Reset to the isometric view',
        onClick: () => this.viewport.setView('iso'),
      }),
      button({
        iconName: 'frame',
        title: 'Fit the model in view',
        onClick: () => this.viewport.frameAll(),
      }),
    ]);

    return [displayTools, cameraTools];
  }

  // -- rendering ------------------------------------------------------------

  /**
   * Renders the active document.
   *
   * `preview` maps to OpenSCAD's F5/F6 split (spec feature 14): it is exposed
   * to the script as `$preview`, so a model can cheapen itself while editing.
   */
  private async render(preview: boolean): Promise<void> {
    const doc = this.workspace.active;
    if (!doc) return;

    this.setBusy(true);
    try {
      await this.client.render({
        source: doc.text,
        files: this.workspace.fileMap(doc.id),
        parameters: doc.parameters,
        assets: this.workspace.assetMap(),
        time: this.animationTime,
        preview,
      });
    } catch (err) {
      this.reportError(err instanceof Error ? err.message : String(err));
    } finally {
      this.setBusy(false);
    }
  }

  private onRenderResult(result: RenderResponse): void {
    this.lastStats = result.stats;
    this.lastDimension = result.dimension;
    this.showingFinalRender = !result.preview;
    this.customizerModel = result.customizer;
    this.fontFamilies = result.fonts;
    this.fontFaces = result.fontFaces;

    if (result.dimension === 2) {
      this.viewport.setContours(result.contours);
    } else {
      this.viewport.setModel(result.meshes, result.annotations, result.bounds);
    }

    // Frame the very first successful render; after that the camera is the
    // user's to control, and stealing it on every keystroke is maddening.
    if (this.booting && result.meshes.length > 0) this.viewport.frameAll();

    this.editor.setDiagnostics(result.diagnostics);
    this.consolePanel.setDiagnostics(result.diagnostics, result.stats);

    const doc = this.workspace.active;
    if (doc) this.customizerPanel.update(result.customizer, doc.parameters);

    this.refreshChrome();
    this.announceResult(result.diagnostics, result.stats);
  }

  private announceResult(diagnostics: Diagnostic[], stats: RenderStats): void {
    const errors = diagnostics.filter((d) => d.severity === 'error').length;
    announce(
      errors > 0
        ? `Render finished with ${errors} error${errors === 1 ? '' : 's'}.`
        : `Rendered ${stats.triangles.toLocaleString()} triangles.`,
    );
  }

  private setBusy(busy: boolean): void {
    this.busyBadge.style.display = busy ? '' : 'none';
  }

  // -- document lifecycle ---------------------------------------------------

  private onSourceChanged(source: string): void {
    const doc = this.workspace.active;
    if (!doc) return;
    doc.text = source;
    this.workspace.persist();
    this.refreshChrome();
    if (this.workspace.layout.autoRender) this.scheduleRender();
  }

  private newDocument(): void {
    this.stashEditorState();
    const doc = this.workspace.createDocument('untitled.bscad', '// New model\n\ncube(10, center = true);\n');
    this.activate(doc);
  }

  private selectDocument(id: string): void {
    if (id === this.workspace.activeId) return;
    this.stashEditorState();
    this.workspace.activeId = id;
    const doc = this.workspace.active;
    if (doc) this.activate(doc);
  }

  /** Saves the live editor state onto the outgoing document (spec feature 12). */
  private stashEditorState(): void {
    const doc = this.workspace.active;
    if (!doc) return;
    doc.editorState = this.editor.state;
    doc.text = this.editor.source;
  }

  private activate(doc: Document): void {
    // Restoring the saved state keeps that tab's undo history and selection.
    this.editor.swapState(doc.editorState ?? this.editor.createState(doc.text));
    this.customizerPanel.update(this.customizerModel, doc.parameters);
    this.workspace.persist();
    this.refreshChrome();
    void this.render(true);
  }

  private async closeDocument(id: string): Promise<void> {
    const doc = this.workspace.documents.find((d) => d.id === id);
    if (!doc) return;

    if (this.workspace.isDirty(doc)) {
      const confirmed = await showConfirm(
        'Close without saving?',
        `"${doc.name}" has unsaved changes. Closing will discard them.`,
        'Discard changes',
      );
      if (!confirmed) return;
    }

    this.workspace.closeDocument(id);
    if (this.workspace.documents.length === 0) {
      this.workspace.createDocument('model.bscad', STARTER_DOCUMENT);
    }
    const next = this.workspace.active;
    if (next) this.activate(next);
  }

  private async openFiles(): Promise<void> {
    try {
      const files = await openScadFiles();
      if (files.length === 0) return;
      this.stashEditorState();
      const opened: Document[] = [];
      let last: Document | undefined;
      for (const file of files) {
        last = this.workspace.createDocument(file.name, file.text, file.handle);
        opened.push(last);
      }
      if (last) this.activate(last);
      this.toasts.show(`Opened ${files.length} file${files.length === 1 ? '' : 's'}.`, 'success');
      this.warnAboutExtensions(opened);
    } catch (err) {
      this.reportError(`Could not open: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async save(): Promise<void> {
    const doc = this.workspace.active;
    if (!doc) return;
    doc.text = this.editor.source;
    const text = this.workspace.serialize(doc, this.cameraMetadata());

    if (doc.handle) {
      const written = await writeToHandle(doc.handle, text);
      if (written) {
        doc.savedText = doc.text;
        this.workspace.persist();
        this.refreshChrome();
        this.toasts.show(`Saved ${doc.name}.`, 'success');
        return;
      }
      // Permission withdrawn or the file moved: fall through to Save As.
      this.toasts.show('Could not write to the original file. Choose a new location.', 'info');
    }
    await this.saveAs();
  }

  /**
   * Save As, optionally converting to another format.
   *
   * The format has to be decided before serialising rather than inferred from
   * whatever name comes back: the picker may be cancelled, and on browsers
   * without the File System Access API it returns nothing at all, so the bytes
   * are already committed by then.
   */
  private async saveAs(format?: DocumentFormat): Promise<void> {
    const doc = this.workspace.active;
    if (!doc) return;
    doc.text = this.editor.source;

    const target = format ?? this.workspace.formatOf(doc);
    const suggested = format ? withFormatExtension(doc.name, format) : doc.name;
    const text = this.workspace.serialize(doc, this.cameraMetadata(), target);

    try {
      const handle = await saveTextAs(suggested, text);
      if (handle) {
        doc.handle = handle;
        doc.name = handle.name;
      } else if (format) {
        // The download fallback wrote `suggested`, so the tab should follow it;
        // otherwise the next plain Save would silently change format again.
        doc.name = suggested;
      }
      // Converting to `.bscad` by name alone is enough to keep the header from
      // here on, so this flag only ever needs clearing — a `.scad` the user
      // deliberately saved as `.scad` should stop carrying an inherited header.
      if (target === 'scad') doc.hadMetadata = false;
      doc.savedText = doc.text;
      this.workspace.persist();
      this.refreshChrome();
      this.toasts.show(`Saved ${doc.name}.`, 'success');
    } catch (err) {
      this.reportError(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Warns when a file named `.scad` turns out to use BetterSCAD syntax.
   *
   * Only `.scad` is worth a warning: a `.bscad` is *expected* to carry
   * extensions, and saying so on every open would be noise.
   */
  private warnAboutExtensions(documents: Document[]): void {
    const offenders: NonStandardFile[] = [];

    for (const doc of documents) {
      if (this.workspace.formatOf(doc) !== 'scad') continue;
      const extensions = this.extensionsIn(doc);
      if (extensions.length > 0) offenders.push({ name: doc.name, extensions });
    }
    if (offenders.length === 0) return;

    // Deliberately not logged to the console: that panel holds the results of
    // one render and is replaced wholesale by the next one, which the open
    // itself triggers. The dialog is the warning, and the Export dialog repeats
    // the same list at the moment it actually matters.
    const single = offenders.length === 1 && offenders[0].name === this.workspace.active?.name;
    showNonStandardSyntaxDialog(offenders, single ? () => void this.saveAs('bscad') : undefined);
  }

  /**
   * The BetterSCAD extensions a document uses.
   *
   * A file that does not parse has no reliable answer, so it reports none: a
   * warning derived from a broken tree would be guesswork, and the parse errors
   * are already in the console.
   */
  private extensionsIn(doc: Document): ExtensionUse[] {
    try {
      const parsed = parse(doc.text, doc.name);
      if (parsed.diagnostics.some((d) => d.severity === 'error')) return [];
      return describeExtensions(parsed.file);
    } catch {
      return [];
    }
  }

  private cameraMetadata(): { rotation: [number, number, number]; target: [number, number, number]; distance: number } {
    const vp = this.viewport.controls.viewportVariables;
    return { rotation: vp.rotation, target: vp.translation, distance: vp.distance };
  }

  // -- export ---------------------------------------------------------------

  private async exportModel(): Promise<void> {
    const doc = this.workspace.active;
    if (!doc) return;

    const choice = await showExportDialog(
      doc.name.replace(/\.[^.]+$/, ''),
      this.lastDimension,
      this.extensionsIn(doc),
    );
    if (!choice) return;

    // Source export never touches the kernel: it is a transpile of the text on
    // screen, so it works even when the model fails to render.
    if (choice.format === 'scad') {
      this.writeLegacyScad(doc, choice.filename);
      return;
    }

    this.setBusy(true);
    try {
      const result = await this.client.exportModel(choice.format, {
        source: doc.text,
        files: this.workspace.fileMap(doc.id),
        parameters: doc.parameters,
        assets: this.workspace.assetMap(),
        time: this.animationTime,
      });
      await saveBinaryAs(choice.filename, result.data, result.mimeType);
      this.toasts.show(`Exported ${choice.filename}.`, 'success');
    } catch (err) {
      this.reportError(err instanceof Error ? err.message : String(err));
    } finally {
      this.setBusy(false);
    }
  }

  /** Legacy `.scad` export, with the extension rewrites surfaced (feature 21). */
  private exportLegacyScad(): void {
    const doc = this.workspace.active;
    if (!doc) return;

    showLegacyExportDialog(this.extensionsIn(doc), () =>
      this.writeLegacyScad(doc, `${doc.name.replace(/\.[^.]+$/, '')}.scad`),
    );
  }

  /**
   * Transpiles a document to stock `.scad` and writes it out.
   *
   * Deliberately not a Save: the result is a lossy derivative — extensions are
   * rewritten and the metadata header is gone — so it must not adopt the tab's
   * handle or clear its dirty flag.
   */
  private writeLegacyScad(doc: Document, filename: string): void {
    const parsed = parse(doc.text, doc.name);
    const errors = parsed.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      this.reportError(`Cannot export source with parse errors: ${errors[0].message}`);
      return;
    }

    const { source, rewrites } = transpileToLegacyScad(parsed.file);
    void saveBinaryAs(filename, new TextEncoder().encode(source), 'text/plain');
    this.toasts.show(
      rewrites.length > 0
        ? `Exported ${filename}, with ${rewrites.length} rewrite${rewrites.length === 1 ? '' : 's'}.`
        : `Exported ${filename}.`,
      'success',
    );
  }

  private async exportScreenshot(): Promise<void> {
    const blob = await this.viewport.capture();
    if (!blob) {
      this.reportError('Could not capture the viewport.');
      return;
    }
    const doc = this.workspace.active;
    const name = `${(doc?.name ?? 'model').replace(/\.[^.]+$/, '')}.png`;
    await saveBinaryAs(name, new Uint8Array(await blob.arrayBuffer()), 'image/png');
    this.toasts.show(`Saved ${name}.`, 'success');
  }

  // -- customizer -----------------------------------------------------------

  private setParameter(name: string, value: Value): void {
    const doc = this.workspace.active;
    if (!doc) return;
    doc.parameters[name] = value;
    this.workspace.persist();
    // Live update, as the spec requires: the render client coalesces the flood
    // of events a slider drag produces.
    void this.render(true);
  }

  private resetParameters(): void {
    const doc = this.workspace.active;
    if (!doc) return;
    doc.parameters = {};
    this.workspace.persist();
    this.customizerPanel.update(this.customizerModel, doc.parameters);
    void this.render(true);
  }

  /** Writes the current parameter values back into the script text. */
  private applyParametersToSource(): void {
    const doc = this.workspace.active;
    if (!doc) return;
    if (Object.keys(doc.parameters).length === 0) {
      this.toasts.show('No customizer values to apply.', 'info');
      return;
    }
    const parsed = parse(doc.text, doc.name);
    const updated = applyParametersToSource(doc.text, parsed.file, doc.parameters);
    if (updated === doc.text) {
      this.toasts.show('The script already matches these values.', 'info');
      return;
    }
    this.editor.setSource(updated);
    doc.text = updated;
    doc.parameters = {};
    this.workspace.persist();
    this.customizerPanel.update(this.customizerModel, doc.parameters);
    this.toasts.show('Values written into the script.', 'success');
    void this.render(true);
  }

  // -- fonts ----------------------------------------------------------------

  /**
   * Font bytes for a family, for previewing in the picker.
   *
   * Three sources, in the order they are cheapest: fonts loaded from disk or
   * the system this session, the bundled files, and the IndexedDB download
   * cache. Returns undefined when the family has not been fetched at all, in
   * which case the picker simply shows no preview until it is loaded.
   */
  private async fontBytesFor(family: string): Promise<Uint8Array | undefined> {
    const local = this.localFontBytes.get(family);
    if (local) return local;

    const bundled = BUNDLED_FONTS.find((f) => f.family === family);
    if (bundled) {
      try {
        const data = await fetchBundledFont(document.baseURI, bundled.file);
        this.localFontBytes.set(family, data);
        return data;
      } catch {
        return undefined;
      }
    }

    return cachedFontBytes(family);
  }

  private async loadBundledFonts(): Promise<void> {
    const base = document.baseURI;
    for (const font of BUNDLED_FONTS) {
      try {
        const data = await fetchBundledFont(base, font.file);
        await this.client.loadFont(data, font.family === DEFAULT_FAMILY);
      } catch {
        // A missing bundled font is not fatal: text() will report it if used.
      }
    }
  }

  private async openFontManager(): Promise<void> {
    if (this.catalog.length === 0) this.catalog = await loadCatalog(document.baseURI);

    showFontDialog(this.fontFaces, this.catalog, {
      loadCatalogFont: async (entry) => {
        const { data } = await fetchCatalogFont(entry);
        const response = await this.client.loadFont(data);
        this.fontFamilies = response.families;
        this.fontFaces = response.faces;
        void this.render(true);
        return data;
      },
      bytesFor: (family) => this.fontBytesFor(family),
      insert: (text) => {
        this.editor.insertAtCursor(text);
        this.toasts.show(`Inserted ${text}`, 'success');
      },
      loadFromDisk: async () => {
        const files = await openFontFiles();
        for (const file of files) {
          const response = await this.client.loadFont(file.data);
          this.fontFamilies = response.families;
          this.fontFaces = response.faces;
          // Kept so the picker can preview a face the user supplied.
          this.localFontBytes.set(response.family ?? file.name, file.data);
        }
        if (files.length > 0) {
          this.toasts.show(`Loaded ${files.length} font file${files.length === 1 ? '' : 's'}.`, 'success');
          void this.render(true);
        }
      },
      loadSystemFonts: async () => {
        const fonts = await querySystemFonts();
        const loaded: string[] = [];
        // Cap this: some machines have thousands of faces, and each one costs
        // a parse plus a structured clone into the worker.
        for (const font of fonts.slice(0, 60)) {
          try {
            const blob = await font.blob();
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const response = await this.client.loadFont(bytes);
            this.fontFamilies = response.families;
            this.fontFaces = response.faces;
            this.localFontBytes.set(response.family ?? font.family, bytes);
            loaded.push(font.family);
          } catch {
            // Skip faces the parser cannot read (bitmap fonts, odd collections).
          }
        }
        if (loaded.length > 0) void this.render(true);
        return loaded;
      },
      clearCache: async () => {
        await clearFontCache();
        this.toasts.show('Downloaded fonts cleared. Bundled fonts are unaffected.', 'success');
      },
    });
  }

  // -- assets ---------------------------------------------------------------

  private async addAssets(): Promise<void> {
    const files = await openBinaryFiles();
    for (const file of files) this.workspace.assets.set(file.name, file.data);
    if (files.length > 0) {
      this.toasts.show(
        `Added ${files.map((f) => f.name).join(', ')}. Reference them by name, e.g. import("${files[0].name}").`,
        'success',
      );
      void this.render(true);
    }
  }

  // -- animation (spec feature 20) ------------------------------------------

  private toggleAnimation(): void {
    if (this.animationBar) {
      this.animationBar.dispose();
      this.animationHost.replaceChildren();
      this.animationBar = undefined;
      this.animationTime = 0;
      void this.render(true);
      return;
    }

    this.animationBar = new AnimationBar({
      onTime: (t) => {
        this.animationTime = t;
        void this.render(true);
      },
      onPlayState: () => undefined,
      onExportFrames: () => void this.exportAnimationFrames(),
      onClose: () => this.toggleAnimation(),
    });
    this.animationHost.replaceChildren(this.animationBar.element);
    this.viewport.resize();
  }

  /**
   * Renders one PNG per frame.
   *
   * Frames are saved individually rather than encoded to a GIF or video in the
   * browser: assembling them is a job for a tool that already does it well, and
   * shipping an encoder would dominate the bundle.
   */
  private async exportAnimationFrames(): Promise<void> {
    const bar = this.animationBar;
    const doc = this.workspace.active;
    if (!bar || !doc) return;

    bar.stop();
    const steps = bar.steps;
    const confirmed = await showConfirm(
      'Export animation frames',
      `This renders ${steps} frames and saves ${steps} PNG files. Continue?`,
      `Export ${steps} frames`,
    );
    if (!confirmed) return;

    const base = doc.name.replace(/\.[^.]+$/, '');
    this.setBusy(true);
    try {
      for (let frame = 0; frame < steps; frame++) {
        this.animationTime = frame / steps;
        await this.render(false);
        const blob = await this.viewport.capture();
        if (!blob) continue;
        const name = `${base}-${String(frame).padStart(4, '0')}.png`;
        await saveBinaryAs(name, new Uint8Array(await blob.arrayBuffer()), 'image/png');
      }
      this.toasts.show(`Exported ${steps} frames.`, 'success');
    } finally {
      this.setBusy(false);
    }
  }

  private showMeasurement(measurement: Parameters<ConstructorParameters<typeof Viewport>[1]['onMeasure']>[0]): void {
    if (!measurement) {
      this.measureReadout.style.display = 'none';
      return;
    }
    const { point, distance, delta } = measurement;
    this.measureReadout.style.display = '';
    this.measureReadout.replaceChildren(
      el('dl', {}, [
        el('dt', { text: 'Point' }),
        el('dd', {
          text: `[${formatNumber(point.x, 3)}, ${formatNumber(point.y, 3)}, ${formatNumber(point.z, 3)}]`,
        }),
        ...(distance !== undefined && delta
          ? [
              el('dt', { text: 'Distance' }),
              el('dd', { text: formatNumber(distance, 4) }),
              el('dt', { text: 'Δ' }),
              el('dd', {
                text: `[${formatNumber(delta.x, 3)}, ${formatNumber(delta.y, 3)}, ${formatNumber(delta.z, 3)}]`,
              }),
            ]
          : [el('dt', { text: '' }), el('dd', { text: 'Click a second point' })]),
      ]),
    );
  }

  // -- layout and theme -----------------------------------------------------

  private toggleCustomizer(): void {
    this.workspace.layout.customizerVisible = !this.workspace.layout.customizerVisible;
    this.applyLayoutVisibility();
    this.workspace.persist();
    this.refreshChrome();
  }

  private toggleConsole(): void {
    this.workspace.layout.consoleVisible = !this.workspace.layout.consoleVisible;
    this.applyLayoutVisibility();
    this.workspace.persist();
    this.refreshChrome();
  }

  private applyLayoutVisibility(): void {
    this.customizerHost.style.display = this.workspace.layout.customizerVisible ? 'flex' : 'none';
    this.rightSplit.setSecondVisible(this.workspace.layout.consoleVisible);
    this.viewport?.resize();
  }

  private toggleTheme(): void {
    const next = this.workspace.layout.theme === 'dark' ? 'light' : 'dark';
    this.workspace.layout.theme = next;
    this.applyTheme(next);
    this.workspace.persist();
    // Repaints the toolbar toggle so its icon and label track the new theme.
    this.refreshChrome();
  }

  private applyTheme(theme: 'light' | 'dark'): void {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#0d1117' : '#f5f7f9');
    // The viewport samples CSS variables, so it must be told to re-read them.
    this.viewport?.applyTheme();
  }

  private refreshChrome(): void {
    this.tabs.update(this.workspace.documents, this.workspace.activeId, (doc) =>
      this.workspace.isDirty(doc),
    );
    const counts = this.consolePanel.counts;
    const active = this.workspace.active;
    this.toolbar.update({
      ...this.workspace.layout,
      showingFinalRender: this.showingFinalRender,
      documentFormat: active ? this.workspace.formatOf(active) : 'bscad',
    });
    this.statusBar.update({
      cursor: this.cursor,
      errors: counts.errors,
      warnings: counts.warnings,
      stats: this.lastStats,
      fileMode: fileAccessMode(),
      busy: this.client?.busy ?? false,
      dimension: this.lastDimension,
      autoRender: this.workspace.layout.autoRender,
    });
  }

  private reportError(message: string): void {
    this.toasts.show(message, 'error');
    this.consolePanel.append({ severity: 'error', message });
    this.refreshChrome();
  }

  // -- commands and shortcuts -----------------------------------------------

  private runShortcut(name: string): boolean {
    switch (name) {
      case 'preview':
        void this.render(true);
        return true;
      case 'render':
        void this.render(false);
        return true;
      case 'save':
        void this.save();
        return true;
      case 'save-as':
        void this.saveAs();
        return true;
      case 'open':
        void this.openFiles();
        return true;
      case 'export':
        void this.exportModel();
        return true;
      case 'palette':
        this.palette.open();
        return true;
      default:
        return false;
    }
  }

  private registerCommands(): void {
    this.registry.registerAll([
      { id: 'file.new', category: 'File', title: 'New file', shortcut: 'Mod+N', run: () => this.newDocument() },
      { id: 'file.open', category: 'File', title: 'Open…', shortcut: 'Mod+O', run: () => void this.openFiles() },
      { id: 'file.save', category: 'File', title: 'Save', shortcut: 'Mod+S', run: () => void this.save() },
      { id: 'file.saveAs', category: 'File', title: 'Save as…', shortcut: 'Mod+Shift+S', run: () => void this.saveAs() },
      {
        id: 'file.saveAsBscad',
        category: 'File',
        title: 'Save as .bscad…',
        run: () => void this.saveAs('bscad'),
      },
      {
        id: 'file.assets',
        category: 'File',
        title: 'Add assets for import() / surface()…',
        run: () => void this.addAssets(),
      },
      {
        id: 'file.legacy',
        category: 'File',
        title: 'Export as legacy .scad…',
        run: () => this.exportLegacyScad(),
      },
      { id: 'file.export', category: 'File', title: 'Export model…', shortcut: 'Mod+E', run: () => void this.exportModel() },
      {
        id: 'file.screenshot',
        category: 'File',
        title: 'Save viewport screenshot',
        run: () => void this.exportScreenshot(),
      },

      { id: 'render.preview', category: 'Render', title: 'Preview ($preview = true)', shortcut: 'F5', run: () => void this.render(true) },
      { id: 'render.full', category: 'Render', title: 'Render ($preview = false)', shortcut: 'F6', run: () => void this.render(false) },
      {
        id: 'render.auto',
        category: 'Render',
        title: 'Toggle auto-render on typing',
        run: () => {
          this.workspace.layout.autoRender = !this.workspace.layout.autoRender;
          this.workspace.persist();
          this.refreshChrome();
          this.toasts.show(`Auto-render ${this.workspace.layout.autoRender ? 'on' : 'off'}.`, 'info');
        },
      },

      { id: 'view.fit', category: 'View', title: 'Fit model in view', run: () => this.viewport.frameAll() },
      { id: 'view.iso', category: 'View', title: 'Isometric view', run: () => this.viewport.setView('iso') },
      { id: 'view.top', category: 'View', title: 'Top view', run: () => this.viewport.setView('top') },
      { id: 'view.bottom', category: 'View', title: 'Bottom view', run: () => this.viewport.setView('bottom') },
      { id: 'view.front', category: 'View', title: 'Front view', run: () => this.viewport.setView('front') },
      { id: 'view.back', category: 'View', title: 'Back view', run: () => this.viewport.setView('back') },
      { id: 'view.left', category: 'View', title: 'Left view', run: () => this.viewport.setView('left') },
      { id: 'view.right', category: 'View', title: 'Right view', run: () => this.viewport.setView('right') },
      {
        id: 'view.grid',
        category: 'View',
        title: 'Toggle grid',
        run: () => {
          this.workspace.layout.showGrid = !this.workspace.layout.showGrid;
          this.viewport.setHelperVisibility({ grid: this.workspace.layout.showGrid });
          this.workspace.persist();
        },
      },
      {
        id: 'view.axes',
        category: 'View',
        title: 'Toggle axes',
        run: () => {
          this.workspace.layout.showAxes = !this.workspace.layout.showAxes;
          this.viewport.setHelperVisibility({ axes: this.workspace.layout.showAxes });
          this.workspace.persist();
        },
      },
      {
        id: 'view.measure',
        category: 'View',
        title: 'Toggle measurement tool',
        run: () => this.viewport.setMeasuring(!this.viewport.measuring),
      },

      { id: 'panel.customizer', category: 'Panels', title: 'Toggle Customizer', run: () => this.toggleCustomizer() },
      { id: 'panel.console', category: 'Panels', title: 'Toggle Console', run: () => this.toggleConsole() },
      { id: 'panel.theme', category: 'Panels', title: 'Toggle light / dark theme', run: () => this.toggleTheme() },
      { id: 'panel.animation', category: 'Panels', title: 'Toggle animation bar ($t)', run: () => this.toggleAnimation() },
      { id: 'panel.fonts', category: 'Panels', title: 'Manage fonts…', run: () => void this.openFontManager() },

      { id: 'edit.undo', category: 'Edit', title: 'Undo', run: () => this.editor.undo() },
      { id: 'edit.redo', category: 'Edit', title: 'Redo', run: () => this.editor.redo() },

      { id: 'help.about', category: 'Help', title: 'About BetterSCAD', run: () => showAboutDialog(ENGINE_VERSION) },
      {
        id: 'help.reset',
        category: 'Help',
        title: 'Reset workspace (discard saved session)',
        run: async () => {
          const confirmed = await showConfirm(
            'Reset workspace?',
            'This clears every open tab and the saved session from this browser. Files already saved to disk are untouched.',
            'Reset',
          );
          if (!confirmed) return;
          Workspace.clearPersisted();
          location.reload();
        },
      },
    ]);
  }

  private installGlobalHandlers(): void {
    window.addEventListener('keydown', (event) => {
      // The editor has its own keymap; let it win while it has focus, except
      // for the palette, which must be reachable from anywhere.
      const inEditor = this.editor.view.dom.contains(document.activeElement);
      const isPalette =
        (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'p';
      if (inEditor && !isPalette) return;
      if (this.palette.isOpen) return;
      if (this.registry.handleKey(event)) event.preventDefault();
    });

    window.addEventListener('beforeunload', (event) => {
      this.stashEditorState();
      this.workspace.persist();
      if (this.workspace.hasUnsavedChanges) {
        // Only meaningful for tabs never written to disk; the session is
        // restored on reload either way.
        event.preventDefault();
        event.returnValue = '';
      }
    });

    // Drag and drop: .scad/.bscad open as tabs, everything else becomes an asset.
    const stop = (event: DragEvent): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', async (event) => {
      stop(event);
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;

      this.stashEditorState();
      const dropped: Document[] = [];
      let opened: Document | undefined;
      for (const file of files) {
        if (/\.(bscad|scad)$/i.test(file.name)) {
          opened = this.workspace.createDocument(file.name, await file.text());
          dropped.push(opened);
        } else if (/\.(ttf|otf|ttc)$/i.test(file.name)) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const response = await this.client.loadFont(bytes);
          this.fontFamilies = response.families;
          this.fontFaces = response.faces;
          this.localFontBytes.set(response.family ?? file.name, bytes);
        } else {
          this.workspace.assets.set(file.name, new Uint8Array(await file.arrayBuffer()));
        }
      }
      if (opened) this.activate(opened);
      else void this.render(true);
      this.toasts.show(`Added ${files.length} file${files.length === 1 ? '' : 's'}.`, 'success');
      this.warnAboutExtensions(dropped);
    });

    window.addEventListener('resize', () => this.viewport.resize());
  }

  private registerServiceWorker(): void {
    // Offline support (spec feature 17). Dev has no service worker, and
    // registering one there would cache the dev server's own module graph.
    if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;

    const register = (): void => {
      // `./sw.js` relative to the page, so the scope matches wherever the
      // static site is deployed (domain root or a GitHub Pages project path).
      navigator.serviceWorker.register('./sw.js', { type: 'module' }).catch((err: unknown) => {
        // Offline support is a bonus; the app works fine without it. Logged
        // rather than swallowed, so a broken worker is at least diagnosable.
        console.warn('Service worker registration failed; offline support is unavailable.', err);
      });
    };

    // Boot finishes after the WASM kernel loads, which is well past `load`, so
    // waiting for that event unconditionally would mean never registering.
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }
}

// ---------------------------------------------------------------------------

const app = new App();
app.start().catch((err: unknown) => {
  const boot = document.getElementById('boot');
  if (boot) {
    boot.classList.add('boot--error');
    const text = boot.querySelector('.boot__text');
    if (text) {
      text.textContent = `BetterSCAD could not start: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  console.error(err);
});
