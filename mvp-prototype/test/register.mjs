// Lets `npm test` run the plain-data modules with no dependencies: Node needs
// file extensions on imports, and the source (written for Vite) leaves them off.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    const relativeWithoutExtension = specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier);
    return next(relativeWithoutExtension ? `${specifier}.ts` : specifier, context);
  },
});
