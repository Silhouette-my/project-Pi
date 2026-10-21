import { protocol, type CustomScheme } from "electron";
import {
  VISUALIZE_FRAME_SCHEME,
  VISUALIZE_FRAME_URL,
  visualizeFrameBootstrap,
  visualizeFrameCsp,
} from "../shared/visualize-frame";

export const VISUALIZE_FRAME_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: VISUALIZE_FRAME_SCHEME,
  privileges: { standard: true, secure: true },
};

export function visualizeFrameResponse(request: Request): Response {
  if (request.method !== "GET" || request.url !== VISUALIZE_FRAME_URL) {
    return new Response("not found", { status: 404 });
  }
  return new Response(visualizeFrameBootstrap(), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": visualizeFrameCsp(),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** A static document endpoint, not a file server or a general renderer bridge. */
export function installVisualizeFrameProtocol(): void {
  protocol.handle(VISUALIZE_FRAME_SCHEME, visualizeFrameResponse);
}
