/**
 * `npm run screenshot` — retakes the screenshots in the README.
 *
 * The app's own pictures were the one thing in this repository still captured
 * by hand, which is why the README showed a toolbar two features out of date.
 * This drives a real Chrome over the DevTools protocol and captures the real
 * app: same engine, same renderer, same fonts.
 *
 * No dependency, and no headless-browser package. Chrome is already installed
 * on any machine doing this work, `--headless` speaks CDP over a WebSocket, and
 * Node has had a global `WebSocket` since 22. The whole driver is the eighty
 * lines below.
 *
 * The state is seeded rather than clicked: the app restores its session from
 * `localStorage`, so writing the session it would have saved puts it in exactly
 * the state we want with no scripted UI interaction to go stale.
 *
 * Usage:
 *   npm run dev          # in another terminal, or point --url at a built site
 *   npm run screenshot
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((path) => existsSync(path));

const url = argValue('--url') ?? 'http://localhost:5174/';
/** Deliberately 2x: the README image is displayed at half this width. */
const SCALE = 2;

function argValue(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

// ---------------------------------------------------------------------------
// A very small CDP client
// ---------------------------------------------------------------------------

async function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else ok(message.result);
      return;
    }
    listeners.get(message.method)?.forEach((fn) => fn(message.params));
  });

  await new Promise((ok, reject) => {
    socket.addEventListener('open', ok, { once: true });
    socket.addEventListener('error', () => reject(new Error(`Cannot reach ${endpoint}`)), { once: true });
  });

  return {
    /** `sessionId` rides at the top level of the message, not inside `params`. */
    send(method, params = {}, sessionId) {
      const id = nextId++;
      socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      return new Promise((ok, reject) => pending.set(id, { resolve: ok, reject }));
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    close: () => socket.close(),
  };
}

/** Runs an expression in the page and returns its value. */
async function evaluate(page, expression) {
  const { result, exceptionDetails } = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'evaluation failed');
  return result.value;
}

/** Polls an expression until it is true, or gives up. */
async function waitFor(page, expression, what, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(page, expression)) return;
    await new Promise((ok) => setTimeout(ok, 250));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

// ---------------------------------------------------------------------------

async function main() {
  if (!CHROME) throw new Error('No Chrome or Chromium found. Install one, or pass --chrome.');

  const shots = [
    {
      file: 'docs/images/screenshot.png',
      width: 1440,
      height: 880,
      // The hero: source, the Customizer's generated controls, a rendered
      // model and the console. Everything the first paragraph claims.
      session: await heroSession(),
      prepare: null,
    },
    {
      file: 'docs/images/files-panel.png',
      width: 1440,
      height: 880,
      session: projectSession(),
      // The directory itself, which no `localStorage` session can carry: the
      // app keeps it in IndexedDB, so the shot seeds the database the app
      // would have written.
      files: PROJECT_FILES,
    },
    {
      file: 'docs/images/reference-view.png',
      width: 1440,
      height: 880,
      session: await heroSession(),
      // Opened through the real command, so the shot cannot show a dialog the
      // app no longer builds this way.
      prepare: `document.querySelector('[aria-label="Help"]').click()`,
      settle: 1200,
    },
  ];

  const profile = await mkdtemp(join(tmpdir(), 'betterscad-shot-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    // The viewport is WebGL2; headless needs to be told it may use a GPU path.
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    `--force-device-scale-factor=${SCALE}`,
    'about:blank',
  ]);
  chrome.stderr.on('data', () => {});

  try {
    const endpoint = await devtoolsEndpoint(profile);
    const browser = await connect(endpoint);

    for (const shot of shots) {
      const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });

      // One connection, many targets: every message for this page carries the
      // session id, so the shots do not need a socket each.
      const page = {
        send: (method, params) => browser.send(method, params, sessionId),
      };

      await page.send('Page.enable');
      await page.send('Runtime.enable');
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: shot.width,
        height: shot.height,
        deviceScaleFactor: SCALE,
        mobile: false,
      });

      // Seeded before the document runs anything of its own, rather than set
      // and then reloaded into. Reloading raced: `readyState` is still
      // "complete" for the outgoing page, so the waits below were satisfied by
      // the page we were trying to replace and one shot came out showing the
      // sample model instead of the session we had just written.
      await page.send('Page.addScriptToEvaluateOnNewDocument', {
        source:
          `localStorage.setItem('betterscad.workspace.v1', ${JSON.stringify(JSON.stringify(shot.session))});` +
          (shot.files ? seedProjectFiles(shot.files) : ''),
      });
      await page.send('Page.navigate', { url });

      await waitFor(page, 'document.readyState === "complete"', 'the page to load');
      await waitFor(
        page,
        '!!document.querySelector(".viewport canvas") && !document.getElementById("boot")',
        'the kernel to start',
      );
      // The render is asynchronous and off the main thread; the status bar only
      // reports triangles once there is geometry to report.
      await waitFor(
        page,
        '/[1-9]/.test(document.querySelector(".statusbar")?.textContent ?? "")',
        'the model to render',
      );
      await new Promise((ok) => setTimeout(ok, 1500));

      if (shot.prepare) {
        await evaluate(page, `(() => { ${shot.prepare}; return true; })()`);
        await new Promise((ok) => setTimeout(ok, shot.settle ?? 800));
      }

      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(ROOT, shot.file), Buffer.from(data, 'base64'));
      console.log(`${shot.file}  ${shot.width * SCALE} x ${shot.height * SCALE}`);

      await browser.send('Target.closeTarget', { targetId });
    }

    browser.close();
  } finally {
    chrome.kill();
    // Chrome keeps writing to its profile as it shuts down, so deleting the
    // directory the moment we signal it races and fails with ENOTEMPTY — after
    // the screenshots have already been written, which made the script report
    // failure for work it had finished. Wait for the exit, and treat a
    // leftover temp directory as not worth failing over.
    await once(chrome, 'exit').catch(() => {});
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

/** Waits for Chrome to write the port it actually chose. */
async function devtoolsEndpoint(profile) {
  const file = join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const [port, path] = (await readFile(file, 'utf8')).split('\n');
      if (port && path) return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
    } catch {
      // Not written yet.
    }
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error('Chrome did not start a DevTools endpoint.');
}

// ---------------------------------------------------------------------------
// The project-files shot
// ---------------------------------------------------------------------------

/**
 * A drawing, a library and an unused file, so the panel shows all three of the
 * things it is for — and the in-use marks show the difference between them.
 */
const PROJECT_FILES = [
  {
    path: 'plate.svg',
    text:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60">' +
      '<rect x="0" y="0" width="120" height="60" rx="10"/>' +
      '<circle cx="12" cy="12" r="4"/><circle cx="108" cy="12" r="4"/>' +
      '<circle cx="12" cy="48" r="4"/><circle cx="108" cy="48" r="4"/>' +
      '<rect x="34" y="18" width="52" height="24" rx="6"/>' +
      '</svg>',
  },
  {
    path: 'MCAD/knurl.scad',
    text: [
      '// A post with a knurled grip.',
      'module knurled_post(h = 12, d = 10, teeth = 24) {',
      '  cylinder(h = h, d = d, $fn = 64);',
      '  for (i = [0 : teeth - 1])',
      '    rotate([0, 0, i * 360 / teeth])',
      '      translate([d / 2 - 0.4, -0.6, 0])',
      '        cube([1.4, 1.2, h]);',
      '}',
      '',
    ].join('\n'),
  },
  // Listed but unreferenced, which is what makes the in-use marks mean
  // something: two files the model uses, one it does not.
  { path: 'terrain.png', text: '\u0089PNG\r\n\u001a\n' },
];

const PROJECT_MODEL = [
  '// Files added once in the Files panel are reachable from every tab, by the',
  '// name they have there — as though they sat in this folder on disk.',
  '',
  'use <MCAD/knurl.scad>',
  '',
  '// The outline, the bolt holes and the window all come out of the drawing.',
  'linear_extrude(5) import("plate.svg");',
  '',
  'translate([60, 30, 5]) knurled_post(h = 16, d = 14);',
  '',
].join('\n');

/** Writes the directory the app keeps in IndexedDB, before the app opens it. */
function seedProjectFiles(files) {
  const records = files.map((f) => ({ path: f.path, text: f.text }));
  return `
    (() => {
      const records = ${JSON.stringify(records)};
      const request = indexedDB.open('betterscad-files', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'path' });
      request.onsuccess = () => {
        const store = request.result.transaction('files', 'readwrite').objectStore('files');
        for (const record of records) {
          store.put({
            path: record.path,
            data: new TextEncoder().encode(record.text).buffer,
            addedAt: Date.now(),
          });
        }
      };
    })();
  `;
}

function projectSession() {
  return {
    version: 1,
    activeId: 'doc-1',
    layout: {
      editorFraction: 0.44,
      consoleFraction: 0.24,
      customizerVisible: false,
      consoleVisible: true,
      filesVisible: true,
      theme: 'dark',
      autoRender: true,
      showGrid: true,
      showAxes: false,
    },
    documents: [
      {
        id: 'doc-1',
        name: 'plate.scad',
        text: PROJECT_MODEL,
        savedText: PROJECT_MODEL,
        metadata: { version: 1 },
        hadMetadata: false,
        parameters: {},
        hadHandle: false,
      },
    ],
  };
}

/** The session the app would have saved with the example box open. */
async function heroSession() {
  const text = await readFile(join(ROOT, 'examples/parametric-box.scad'), 'utf8');
  return {
    version: 1,
    activeId: 'doc-1',
    layout: {
      editorFraction: 0.44,
      consoleFraction: 0.24,
      customizerVisible: true,
      consoleVisible: true,
      theme: 'dark',
      autoRender: true,
      showGrid: true,
      // Off for the hero shot only. The model sits on the origin, so the Z axis
      // runs straight up through the middle of it and skewers the one thing the
      // picture is of. The grid still says "CAD" on its own.
      showAxes: false,
    },
    documents: [
      {
        id: 'doc-1',
        name: 'parametric-box.scad',
        text,
        savedText: text,
        metadata: { version: 1 },
        hadMetadata: false,
        parameters: {},
        hadHandle: false,
      },
    ],
  };
}

await main();
