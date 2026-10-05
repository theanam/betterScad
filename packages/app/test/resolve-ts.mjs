/**
 * Lets the tests import the app's TypeScript the way the app itself does.
 *
 * Source files import each other as `./thing.js`, which is what TypeScript and
 * the bundler expect; Node's type stripping runs the `.ts` file but does not
 * rewrite the specifier. This hook does that one thing: a relative `.js` that
 * does not exist resolves to the `.ts` beside it.
 */

import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      try {
        return await next(specifier, context);
      } catch (error) {
        if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js')) {
          return next(specifier.slice(0, -3) + '.ts', context);
        }
        throw error;
      }
    }
  `)}`,
  import.meta.url,
);
