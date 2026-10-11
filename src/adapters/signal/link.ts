/**
 * Device-link flow (ticket 2.3). Uses the daemon's startLink/finishLink.
 * The link URI is a `sgnl://linkdevice?...` string the operator scans as a QR.
 */
import { jsonRpc } from "./jsonRpc.js";

export interface StartLinkResult {
  deviceLinkUri: string;
}

export interface FinishLinkResult {
  number?: string;
}

export async function startLink(endpoint: string): Promise<string> {
  const result = await jsonRpc<StartLinkResult>(endpoint, "startLink", {});
  return result.deviceLinkUri;
}

export async function finishLink(endpoint: string, deviceLinkUri: string): Promise<string> {
  const result = await jsonRpc<FinishLinkResult>(endpoint, "finishLink", { deviceLinkUri });
  return result.number ?? "";
}

/** Pure: operator-facing instructions for a link URI. */
export function linkInstructions(deviceLinkUri: string): string {
  return [
    "Link this device to your Signal account:",
    "1. In Signal: Settings -> Linked Devices -> Link New Device.",
    "2. Scan the QR below (or generate one from the URI).",
    "",
    deviceLinkUri,
    "",
    "The URI is valid briefly; re-run the link command if it expires.",
  ].join("\n");
}
