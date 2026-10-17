// Worker entrypoint. Only the default export lives here: the Workers runtime treats
// every named export of the main module as an entrypoint, so helpers live in app.js.
import { handle } from './app.js';

export default {
  fetch(request, env, ctx) {
    return handle(request, env, { waitUntil: ctx && ctx.waitUntil ? (p) => ctx.waitUntil(p) : undefined });
  },
};
