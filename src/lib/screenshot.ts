import { toPng } from "html-to-image";
import { invoke } from "@/lib/tauri";

const DATA_URL_PREFIX = /^data:image\/png;base64,/;

function getAppRoot(): HTMLElement {
  const root = document.getElementById("root");
  if (!(root instanceof HTMLElement)) {
    throw new Error("Unable to capture the window because the app root was not found.");
  }
  return root;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function waitForSettledUi(): Promise<void> {
  // The context-menu action closes the portal menu first. Waiting for the
  // next paints keeps that menu (and any previous toast) out of the capture.
  await nextFrame();
  await nextFrame();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "Unknown error.";
}

export function formatScreenshotError(error: unknown): string {
  const message = getErrorMessage(error).replace(/^error:\s*/i, "");
  return message.length > 160 ? `${message.slice(0, 157)}...` : message;
}

/**
 * Captures the current app window as a PNG and saves it to the desktop.
 * Returns the path of the saved file.
 */
export async function takeScreenshot(): Promise<string> {
  const root = getAppRoot();
  await waitForSettledUi();

  let dataUrl: string;
  try {
    dataUrl = await toPng(root, {
      cacheBust: true,
      pixelRatio: window.devicePixelRatio || 1,
      filter: (node) =>
        !(
          node instanceof HTMLElement &&
          node.dataset.screenshotExclude === "true"
        ),
    });
  } catch (error) {
    throw new Error(
      `Unable to capture the window: ${formatScreenshotError(error)}`,
    );
  }

  try {
    return await invoke<string>("take_screenshot", {
      imageData: dataUrl.replace(DATA_URL_PREFIX, ""),
    });
  } catch (error) {
    throw new Error(
      `Unable to save the screenshot: ${formatScreenshotError(error)}`,
    );
  }
}
