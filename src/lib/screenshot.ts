import html2canvas from "html2canvas";
import { invoke } from "@/lib/tauri";

/**
 * Captures the current app window as a PNG and saves it to the desktop.
 * Returns the path of the saved file.
 */
export async function takeScreenshot(): Promise<string> {
  const canvas = await html2canvas(document.body, {
    // Use the existing canvas elements (xterm) directly to capture terminal
    // output accurately.
    useCORS: true,
    allowTaint: true,
    logging: false,
  });

  // Strip the data-URL prefix before sending to Rust.
  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");

  const path = await invoke<string>("take_screenshot", { imageData: base64 });
  return path;
}
