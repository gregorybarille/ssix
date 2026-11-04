import type { Terminal as XTerm } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";

/**
 * GPU rendering when the WebView offers WebGL, or null and the DOM renderer when
 * not. A lost context, or disposing the addon, puts the DOM renderer back too.
 */
export function loadWebglRenderer(term: XTerm): WebglAddon | null {
  let webgl: WebglAddon | null = null;
  try {
    webgl = new WebglAddon();
    const loaded = webgl;
    loaded.onContextLoss(() => loaded.dispose());
    term.loadAddon(loaded);
    return loaded;
  } catch {
    // xterm keeps an addon that failed to activate; this is tried again on each show.
    webgl?.dispose();
    return null;
  }
}
