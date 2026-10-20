import { describe, expect, it } from "vitest";
import { createChatGptModelRouteObserver } from "./chatgpt-model-route.js";

describe("ChatGPT model-route observer", () => {
  it("collects execution slugs and flags only from server STE metadata", () => {
    const observer = createChatGptModelRouteObserver();
    observer.observe({ message: { metadata: { server_ste_metadata: { model_slug: "gpt-5-mini", did_auto_switch_to_reasoning: false, product_experience: "chat", turn_use_case: "chat", server_ttfvt_ms: 412 } } } });
    observer.observe({ type: "server_ste_metadata", model_slug: "gpt-5" });
    const result = observer.result();
    expect(result.exec).toEqual(["gpt-5-mini", "gpt-5"]);
    expect(result.flags).toMatchObject({ did_auto_switch_to_reasoning: false, product_experience: "chat", server_ttfvt_ms: 412 });
  });

  it("ignores request-side echo slugs and answer content", () => {
    const observer = createChatGptModelRouteObserver();
    observer.observe({ message: { metadata: { model_slug: "gpt-6" }, content: { parts: [{ model_slug: "gpt-embedded" }] } } });
    expect(observer.result()).toEqual({ exec: [], flags: {} });
  });

  it("identifies STE nodes by their own characteristic fields", () => {
    const observer = createChatGptModelRouteObserver();
    observer.observe({ debug: { requested_model_experience: "gpt-6", model_slug: "gpt-5-mini" } });
    expect(observer.result().exec).toEqual(["gpt-5-mini"]);
  });
});
