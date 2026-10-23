/**
 * The first-run tour: what the app can do, one picture at a time.
 *
 * Shown once, before the welcome, and never again unless asked for — the
 * flag lives in localStorage, which outlives the session. Every slide is a
 * picture first and a few lines second, because a capability is quicker to
 * see than to read about, and the pictures are the README's own screenshots
 * and the reference's rendered examples, so nothing here can drift from what
 * the app actually does.
 *
 * Skippable at every step: Skip, Escape, or clicking outside. Nothing is
 * lost by skipping; the sample model is already open behind it.
 */

import { button, el, icon } from './dom.js';
import { IMAGE_DIR as REFERENCE_DIR } from '../reference/index.js';

/** Matches `TOUR_DIR` in `vite.config.ts`: where the README's screenshots are served. */
const TOUR_DIR = 'tour';
const SEEN_KEY = 'betterscad.tour.v1';

export function tourSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === 'seen';
  } catch {
    return true;
  }
}

export function markTourSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, 'seen');
  } catch {
    // Storage blocked: the tour shows again next time, which is the lesser evil.
  }
}

interface Picture {
  src: string;
  alt: string;
  /** A caption under a small picture in a grid. */
  caption?: string;
}

interface Slide {
  /** A short label above the title, the slide's place in the story. */
  kicker: string;
  title: string;
  /** Lines of body text; `<b>` and `<code>` are allowed. */
  body: string[];
  /** One big picture, or a grid of rendered examples. */
  picture?: Picture;
  grid?: Picture[];
  /** Where to keep the big picture's attention when it is cropped. */
  focus?: string;
}

const shot = (name: string, alt: string): Picture => ({ src: `./${TOUR_DIR}/${name}.png`, alt });
const example = (name: string, caption: string): Picture => ({ src: `./${REFERENCE_DIR}/${name}.png`, alt: caption, caption });

const SLIDES: Slide[] = [
  {
    kicker: 'Welcome',
    title: 'CAD in your browser',
    body: [
      'BetterSCAD is a modern editor for the <b>OpenSCAD</b> language. Open any <b>.scad</b> file and it renders unchanged.',
      'Everything runs on your machine: <b>no server, no account, nothing uploaded</b>. It works offline, and it installs like an app.',
    ],
    picture: shot('screenshot', 'The editor: code on the left, a rendered project box on the right'),
    focus: '50% 40%',
  },
  {
    kicker: 'Write',
    title: 'The model renders as you type',
    body: [
      'Autocomplete with every call form, the signature kept on screen while you fill it in, and errors shown inline.',
      'The <b>Customizer</b> turns your <code>//</code> comments into sliders and dropdowns. Type <b>5in</b> and get 127: the file stays in millimetres.',
    ],
    picture: shot('screenshot', 'The Customizer with sliders generated from the script'),
    focus: '0% 100%',
  },
  {
    kicker: 'Draw',
    title: 'Not every shape starts as code',
    body: [
      'A drawing board with lines, a <b>pen</b> for curves, boxes and circles, measurements you can type into, and smart guides.',
      'Put a photo behind it, scale it to a known distance, and <b>trace</b> it — by hand, or automatically with a small on-device model. Group outlines and <b>erase</b> where they overlap.',
      'Done saves an SVG into the project and extrudes it with one line.',
    ],
    picture: shot('drawing-board', 'The drawing board with a box, a hole, a curve, and a faded reference picture'),
  },
  {
    kicker: 'Files',
    title: 'One folder every tab can see',
    body: [
      'Add images, drawings, meshes, fonts and libraries once; <b>import()</b>, <b>surface()</b>, <b>use</b> and <b>text()</b> reach them by name from any tab.',
      'Name a font and it loads itself — fifty Google Fonts, the ones on your machine, or your own file. Save as <b>.zip</b> packs the model with every file it uses.',
    ],
    picture: shot('files-panel', 'The Files panel listing a drawing, a library and an image'),
  },
  {
    kicker: 'Language · negative()',
    title: 'Holes where they belong',
    body: [
      'Wrap a shape in <b>negative()</b> and it becomes a hole, carved out of everything in the same scope — so a bolt hole can sit next to the boss it goes through instead of a <code>difference()</code> at the top of the file.',
      'Every addition has a defined way back to plain <b>.scad</b>; Save as OpenSCAD rewrites it for you.',
    ],
    picture: shot('negative-extension', 'The same plate and cylinders as solids, then wrapped in negative() as holes'),
  },
  {
    kicker: 'Language · shapes',
    title: 'Rounded, chamfered, eased',
    body: [
      '<b>cube(r)</b> and <b>square(r)</b> round every edge; <b>chamfer</b> breaks them flat. <b>cylinder(chamfer)</b> finishes a rim. <b>linear_extrude(ease)</b> flares a profile along a curve instead of a straight taper. <b>text(radius)</b> sets type on a circle.',
    ],
    grid: [
      example('cube-radius', 'cube(r)'),
      example('cube-chamfer', 'cube(chamfer)'),
      example('cylinder-chamfer', 'cylinder(chamfer)'),
      example('linear-extrude-ease', 'linear_extrude(ease)'),
      example('text-radius', 'text(radius)'),
      example('square-radius-stadium', 'square(r)'),
    ],
  },
  {
    kicker: 'Language · parts',
    title: 'Parts you would otherwise download',
    body: [
      '<b>thread()</b> cuts real ISO, square and round threads, inside or out. <b>gear()</b> makes spur, helical and ring gears that mesh. <b>regular_polygon()</b> is the hexagon you keep writing by hand.',
    ],
    grid: [
      example('thread', 'thread()'),
      example('thread-nut', 'thread(), as a nut'),
      example('gear', 'gear()'),
      example('gear-pair', 'two gears that mesh'),
      example('regular-polygon', 'regular_polygon()'),
      example('gear-ring', 'ring gear'),
    ],
  },
  {
    kicker: 'Language · shorthands',
    title: 'Less typing, more modelling',
    body: [
      '<b>translatez(5)</b>, <b>rotatex(90)</b>, <b>mirrory()</b> instead of a vector for one axis. <b>translate(x, y, z)</b> with loose numbers. <b>get_size()</b> and <b>get_position()</b> measure a shape so the next one can follow it; <b>center()</b> lines one up on another. A C-style <b>for</b> loop. All of it rewritten to stock OpenSCAD on save.',
    ],
    grid: [
      example('rotatex', 'rotatex()'),
      example('mirrorx', 'mirrorx()'),
      example('get_size', 'get_size()'),
      example('cube-centerxy', 'cube(centerxy)'),
      example('negative-bubble', 'negative() in a scope'),
      example('square-radius-extruded', 'square(r), extruded'),
    ],
  },
  {
    kicker: 'Help',
    title: 'A reference for every element',
    body: [
      'Press <b>F1</b> for the reference: the whole language, OpenSCAD and the additions, written for someone who has never used CAD, each with a rendered example you can insert.',
      'The Console’s <b>Info</b> tab lists which extensions a file uses and previews the plain .scad it becomes.',
    ],
    picture: shot('reference-view', 'The Help & Reference view showing cube() with rendered examples'),
  },
  {
    kicker: 'Finish',
    title: 'Export, print, automate',
    body: [
      'Export <b>STL, 3MF, OFF, AMF</b> for printing, <b>SVG and DXF</b> for cutting, PNG pictures at up to 4K, or plain .scad. A headless <b>CLI</b> renders the same files in CI.',
      'Preview with <b>F5</b>, render with <b>F6</b>, and <b>⌘K</b> finds any command. Panels drag anywhere; the layout is remembered.',
    ],
    picture: shot('screenshot', 'A rendered model in the viewport, with the console beneath it'),
    focus: '100% 100%',
  },
];

export interface TourCallbacks {
  /** Called when the tour closes, by any route. */
  onClose(): void;
}

export function showTour(callbacks: TourCallbacks): HTMLDialogElement {
  let index = 0;
  // Focusable itself, so the keys work from the start without a button
  // taking focus and showing its hint before anyone has moved the mouse.
  const dialog = el('dialog', { class: 'tour', 'aria-label': 'A tour of BetterSCAD', tabindex: '-1' }) as HTMLDialogElement;

  const kicker = el('div', { class: 'tour__kicker' });
  const title = el('h2', { class: 'tour__title' });
  const body = el('div', { class: 'tour__body' });
  const visual = el('div', { class: 'tour__visual' });
  const dots = el('div', { class: 'tour__dots', role: 'tablist' });
  const counter = el('span', { class: 'tour__counter' });

  const back = button({ label: 'Back', variant: 'ghost', onClick: () => go(index - 1) });
  const next = button({ label: 'Next', variant: 'primary', onClick: () => go(index + 1) });
  const skip = button({ label: 'Skip the tour', variant: 'ghost', onClick: () => dialog.close() });

  const dotButtons = SLIDES.map((slide, i) => {
    const dot = el('button', { class: 'tour__dot', type: 'button', role: 'tab', 'aria-label': `${i + 1}. ${slide.title}`, onclick: () => go(i) });
    dots.appendChild(dot);
    return dot;
  });

  const panel = el('div', { class: 'tour__panel' }, [
    visual,
    el('div', { class: 'tour__text' }, [kicker, title, body]),
  ]);

  dialog.append(
    el('div', { class: 'tour__head' }, [
      el('img', { src: './betterscad-mark.svg', width: '28', height: '28', alt: '' }),
      el('span', { class: 'tour__brand', text: 'BetterSCAD' }),
      el('span', { class: 'toolbar__spacer' }),
      counter,
      skip,
    ]),
    panel,
    el('div', { class: 'tour__foot' }, [back, dots, next]),
  );

  // Preload the next picture so a slide never arrives blank.
  const preload = (i: number): void => {
    const slide = SLIDES[i];
    if (!slide) return;
    for (const p of [slide.picture, ...(slide.grid ?? [])]) {
      if (p) new Image().src = p.src;
    }
  };

  const go = (to: number): void => {
    if (to >= SLIDES.length) {
      dialog.close();
      return;
    }
    index = Math.max(0, Math.min(SLIDES.length - 1, to));
    const slide = SLIDES[index];
    kicker.textContent = slide.kicker;
    title.textContent = slide.title;
    body.replaceChildren(...slide.body.map((line) => el('p', { html: line })));
    visual.replaceChildren();
    if (slide.picture) {
      const img = el('img', { class: 'tour__picture', src: slide.picture.src, alt: slide.picture.alt, decoding: 'async' });
      if (slide.focus) img.style.objectPosition = slide.focus;
      visual.appendChild(img);
    } else if (slide.grid) {
      visual.appendChild(
        el('div', { class: 'tour__grid' }, slide.grid.map((p) =>
          el('figure', { class: 'tour__cell' }, [
            el('img', { src: p.src, alt: p.alt, decoding: 'async' }),
            el('figcaption', { text: p.caption ?? '' }),
          ]),
        )),
      );
    }
    // Replay the entrance so a change of slide reads as a change.
    panel.classList.remove('tour__panel--in');
    void panel.offsetWidth;
    panel.classList.add('tour__panel--in');

    dotButtons.forEach((dot, i) => dot.setAttribute('aria-selected', String(i === index)));
    counter.textContent = `${index + 1} / ${SLIDES.length}`;
    back.disabled = index === 0;
    next.replaceChildren(index === SLIDES.length - 1 ? 'Get started' : 'Next', icon('chevron-right', 13));
    next.classList.toggle('tour__next--last', index === SLIDES.length - 1);
    preload(index + 1);
  };

  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(index + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(index - 1);
    }
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    markTourSeen();
    dialog.remove();
    callbacks.onClose();
  });

  document.body.appendChild(dialog);
  go(0);
  dialog.showModal();
  dialog.focus();
  return dialog;
}
