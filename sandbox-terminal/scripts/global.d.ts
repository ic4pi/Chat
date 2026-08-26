// Ambient declaration for the Puppeteer page.evaluate() callbacks in this
// directory — they run in the browser, where Terminal.tsx sets this global.
import type { Terminal } from '@xterm/xterm';

export {};
declare global {
  interface Window {
    __sandboxTerm?: Terminal;
  }
}
