import { ui } from "../lang/ru";
import { localizeApiMessage } from "../studio/lib/localizeApiMessage";

/** Read and localize a bounded public API error response, falling back on unreadable bodies. */
export async function readApiMessage(response, fallback = ui.messages.actionFailed) {
  try {
    const data = await response.json();
    return localizeApiMessage(data?.message, fallback);
  } catch {
    return fallback;
  }
}
