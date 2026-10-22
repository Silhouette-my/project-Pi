import type { SessionSummary } from "@pi-desktop/shared";
import {
  initialThinkingLevelForBinding,
  initialThinkingLevelForUnmatchedModel,
} from "@pi-desktop/shared";
import type { TFunction } from "i18next";
import { composerModelDisplayName, sameComposerModelId } from "../../../../lib/composer-models";
import { inheritedSessionModelBinding } from "../../../../lib/session-model";
import { resolveComposerThinkingProvider } from "../../../../lib/session-thinking";
import type { DraftSessionConfiguration } from "../../../../stores/app-state";
import { useAppStore } from "../../../../stores/app-store";
import { isThinkingLevel, thinkingLevelForProvider, thinkingProviderForModel } from "../model";

/**
 * Resolves the model and effort a composer presents for one conversation.
 *
 * Shared by the chat Composer (the active session or the new-chat draft) and
 * detached conversations (project Agent dock, side conversations), so every
 * composer applies the same inheritance, catalog and thinking-ladder rules.
 */
export function useSessionModelSelection({
  session,
  draft,
  remote = false,
  t,
}: {
  /** The conversation being composed into, when it exists. */
  session?: SessionSummary;
  /** Configuration for a conversation that does not exist yet. */
  draft?: DraftSessionConfiguration | null;
  /** Remote sessions report their own binding; nothing is inherited locally. */
  remote?: boolean;
  t: TFunction;
}) {
  const providers = useAppStore((s) => s.providers);
  const providerModels = useAppStore((s) => s.providerModels);
  const settings = useAppStore((s) => s.settings);
  const recentModels = useAppStore((s) => s.recentModels);

  const selectedModel = remote
    ? { providerId: session?.providerId, modelId: session?.modelId }
    : inheritedSessionModelBinding({ draft: session ?? draft, settings, providers, recentModels });
  const provider = providers.find((candidate) => candidate.id === selectedModel.providerId);
  const modelId = selectedModel.modelId;
  const selectedModelCatalog = provider ? providerModels[provider.id] : undefined;
  const catalogThinkingProvider = thinkingProviderForModel(
    provider,
    modelId,
    selectedModelCatalog,
  );
  const thinkingProvider = resolveComposerThinkingProvider({
    provider,
    modelId,
    activeSession: session,
    catalogThinkingProvider,
  });
  const selectedBinding = provider?.models.find((candidate) =>
    sameComposerModelId(candidate.id, modelId ?? ""),
  );
  const selectedModelInfo = selectedModelCatalog?.find((candidate) =>
    sameComposerModelId(candidate.modelId, modelId ?? ""),
  );
  // A draft without a session starts at the selected model's stored default
  // thinking level, clamped onto that binding's enabled ladder.
  const draftThinkingLevel = selectedModelInfo?.catalogSource === "models.dev"
    ? initialThinkingLevelForBinding(
        selectedBinding,
        thinkingProvider?.supportedThinkingLevels,
      )
    : initialThinkingLevelForUnmatchedModel(
        selectedBinding,
        thinkingProvider?.supportedThinkingLevels,
      );
  const sessionThinkingLevel =
    session?.thinkingLevel ??
    (!session ? draft?.thinkingLevel : undefined) ??
    draftThinkingLevel;
  const configuredThinkingLevel = isThinkingLevel(sessionThinkingLevel)
    ? sessionThinkingLevel
    : "off";
  const thinkingLevel = thinkingLevelForProvider(
    thinkingProvider,
    configuredThinkingLevel,
  );
  const modelLabel = modelId
    ? composerModelDisplayName(provider, modelId)
    : t("chat.model");

  return { provider, modelId, thinkingProvider, thinkingLevel, modelLabel };
}
