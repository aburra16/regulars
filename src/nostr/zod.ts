import { config } from "zod";

/*
 * Nostrify checks what relays and phone apps send with zod. zod compiles a check with `new Function`
 * where it can, and first tries whether it can; the site's Content Security Policy allows no eval
 * (tools/csp.ts), and the browser reports that try as a violation, though zod catches what it throws
 * and checks without compiling. Told so here, it does not try. Each module that loads Nostrify imports
 * this first (tests/csp.test.ts checks that they do).
 */
config({ jitless: true });
