import { ui } from "../../lang/ru";
import { localizeApiMessage } from "../../studio/lib/localizeApiMessage";

/** Read and localize a bounded public admin error response. */
export async function readAdminApiMessage(
  response,
  fallback = ui.messages.actionFailed
) {
  try {
    const data = await response.json();
    return localizeApiMessage(data?.message, fallback);
  } catch {
    return fallback;
  }
}
