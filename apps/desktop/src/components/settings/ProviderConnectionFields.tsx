/**
 * The connection half of the AI service form: which service, its key, and for
 * a custom endpoint the name, URL and API format (D310, D625).
 *
 * The chosen service reads as a settled fact with a Change action rather than
 * an open menu. Whether the service answered is announced by the probe itself
 * (`useProbeFeedback`), so pasting a key is visibly the whole job on a named
 * service without a status row holding the dialog open for it.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { CatalogApiStyle, ChatGptChatStatus } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button, Field, Input, TooltipButton } from "../ui";
import { IconTrash } from "../icons";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { ServiceMonogram } from "./ServiceMonogram";
import { endpointLabel } from "./service-catalog";
import { API_STYLE_LABEL_KEYS, CUSTOM_PROVIDER_API_STYLES } from "./provider-api-style";

const CHATGPT_STATUS_LABEL_KEYS = {
  signed_out: "settings.chatgptChatLoggedOut",
  checking: "settings.chatgptChatCheckingStatus",
  challenge: "settings.chatgptChatChallenge",
  error: "settings.chatgptChatError",
  signed_in: "settings.chatgptChatLoggedIn",
} as const;

export type ProviderConnectionFieldsProps = {
  named: boolean;
  custom: boolean;
  editing: boolean;
  saving: boolean;
  serviceLabel: string;
  /** Optional hint for a key that belongs to a Host-owned plugin row. */
  apiKeyHint?: string;
  /** Endpoint the named preset talks to; empty on a custom endpoint. */
  serviceBaseUrl: string;
  /** Hides service switching when the manifest owns this provider row. */
  lockedService?: boolean;
  onChangeService: () => void;
  apiKeyRef: RefObject<HTMLInputElement | null>;
  nameRef: RefObject<HTMLInputElement | null>;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  hasSavedApiKey?: boolean;
  onClearApiKey?: () => void;
  name: string;
  onNameChange: (value: string) => void;
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  commitBaseUrl: () => void;
  baseUrlError?: string;
  apiStyle: CatalogApiStyle;
  onApiStyleChange: (value: CatalogApiStyle) => void;
  /** What the endpoint itself said about the format, when it said anything. */
  apiStyleNote?: string;
  accountOnlyApiStyle: boolean;
  requiresApiStyleChoice: boolean;
  onChatgptLoginChanged?: () => void;
};

export function ProviderConnectionFields({
  named,
  custom,
  editing,
  saving,
  serviceLabel,
  apiKeyHint,
  serviceBaseUrl,
  lockedService = false,
  onChangeService,
  apiKeyRef,
  nameRef,
  apiKey,
  onApiKeyChange,
  hasSavedApiKey = false,
  onClearApiKey,
  name,
  onNameChange,
  baseUrl,
  onBaseUrlChange,
  commitBaseUrl,
  baseUrlError,
  apiStyle,
  onApiStyleChange,
  apiStyleNote,
  accountOnlyApiStyle,
  requiresApiStyleChoice,
  onChatgptLoginChanged,
}: ProviderConnectionFieldsProps) {
  const { t } = useTranslation();
  const keyHint = custom && !hasSavedApiKey
    ? t("settings.apiKeyOptionalHint")
    : editing ? t("settings.apiKeyKeepHint") : undefined;
  const chatgptStyle = custom && apiStyle === "chatgpt_conversation";
  const [chatgptStatus, setChatgptStatus] = useState<ChatGptChatStatus | null>(null);
  const [chatgptBusy, setChatgptBusy] = useState(false);
  const [chatgptError, setChatgptError] = useState<string | null>(null);
  const chatgptRequest = useRef(0);
  const chatgptStatusRef = useRef<ChatGptChatStatus | null>(null);
  const loginChangedRef = useRef(onChatgptLoginChanged);
  loginChangedRef.current = onChatgptLoginChanged;
  const chatgptLoggedIn = chatgptStatus?.loggedIn ?? null;

  const acceptChatgptStatus = (status: ChatGptChatStatus) => {
    chatgptStatusRef.current = status;
    setChatgptStatus(status);
    setChatgptError(null);
  };

  useEffect(() => {
    if (chatgptStatus?.loggedIn) {
      loginChangedRef.current?.();
    }
  }, [chatgptStatus?.loggedIn]);

  useEffect(() => {
    const requestId = ++chatgptRequest.current;
    setChatgptBusy(false);
    if (!chatgptStyle) {
      chatgptStatusRef.current = null;
      setChatgptStatus(null);
      setChatgptError(null);
      return;
    }
    let current = true;
    void api.chatgptChatStatus().then((status) => {
      if (current && requestId === chatgptRequest.current) acceptChatgptStatus(status);
    }).catch((error: unknown) => {
      if (current && requestId === chatgptRequest.current) {
        const message = error instanceof Error ? error.message : String(error);
        const status: ChatGptChatStatus = { loggedIn: false, state: "error", message };
        chatgptStatusRef.current = status;
        setChatgptStatus(status);
        setChatgptError(message);
      }
    });
    return () => {
      current = false;
      chatgptRequest.current += 1;
    };
  }, [chatgptStyle]);

  useEffect(() => {
    if (!chatgptStyle || !chatgptBusy || chatgptLoggedIn === true) return;
    const requestId = chatgptRequest.current;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const status = await api.chatgptChatStatus();
        if (!active || requestId !== chatgptRequest.current) return;
        acceptChatgptStatus(status);
        if (status.loggedIn) {
          chatgptRequest.current += 1;
          setChatgptBusy(false);
          return;
        }
      } catch (error) {
        if (!active || requestId !== chatgptRequest.current) return;
        setChatgptError(error instanceof Error ? error.message : String(error));
      }
      if (active && requestId === chatgptRequest.current) {
        timer = window.setTimeout(() => void poll(), 1_000);
      }
    };
    timer = window.setTimeout(() => void poll(), 1_000);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [chatgptBusy, chatgptLoggedIn, chatgptStyle]);

  const changeChatgptLogin = async (importPrevious = false) => {
    const requestId = chatgptRequest.current;
    setChatgptBusy(true);
    setChatgptError(null);
    try {
      if (importPrevious) {
        const status = await api.chatgptChatImportLogin();
        if (requestId === chatgptRequest.current) acceptChatgptStatus(status);
      } else if (chatgptLoggedIn) {
        await api.chatgptChatLogout();
        if (requestId === chatgptRequest.current) {
          acceptChatgptStatus({ loggedIn: false, state: "signed_out" });
        }
      } else {
        acceptChatgptStatus({ loggedIn: false, state: "checking" });
        const status = await api.chatgptChatLogin();
        if (requestId === chatgptRequest.current) acceptChatgptStatus(status);
      }
    } catch (error) {
      if (requestId === chatgptRequest.current) {
        const message = error instanceof Error ? error.message : String(error);
        setChatgptError(message);
        if (!chatgptStatusRef.current?.loggedIn) {
          const status: ChatGptChatStatus = { loggedIn: false, state: "error", message };
          chatgptStatusRef.current = status;
          setChatgptStatus(status);
        }
      }
    } finally {
      if (requestId === chatgptRequest.current) setChatgptBusy(false);
    }
  };
  const chatgptStatusLabel = chatgptStatus
    ? t(CHATGPT_STATUS_LABEL_KEYS[chatgptStatus.state])
    : t("settings.chatgptChatCheckingStatus");

  return (
    <div className={named ? "provider-setup-fields is-named" : "provider-setup-fields is-custom"}>
      <div
        className={`provider-setup-field-row provider-setup-service-row ${
          named ? "is-named" : "is-single"
        }`}
      >
        {/* Not a Field: its <label> would forward clicks to the Change button. */}
        <div className="block space-y-1.5">
          <div className="text-sm text-text-secondary">{t("settings.service")}</div>
          <div className="provider-service-chip">
            <ServiceMonogram name={serviceLabel} />
            <span className="provider-service-chip-copy">
              <span className="provider-service-chip-name">{serviceLabel}</span>
              {serviceBaseUrl ? (
                <span className="provider-service-chip-host" title={serviceBaseUrl}>
                  {endpointLabel(serviceBaseUrl)}
                </span>
              ) : null}
            </span>
            {!lockedService ? (
              <button
                type="button"
                className="provider-service-chip-change"
                disabled={saving}
                onClick={onChangeService}
              >
                {t("settings.changeService")}
              </button>
            ) : null}
          </div>
        </div>

        {named && !chatgptStyle ? (
          <div className="provider-setup-key">
            <Field label={t("settings.apiKey")} hint={apiKeyHint ?? keyHint}>
              <Input
                ref={apiKeyRef}
                type="password"
                value={apiKey}
                placeholder="sk-…"
                className="font-mono text-sm-plus"
                autoComplete="off"
                autoFocus
                onChange={(event) => onApiKeyChange(event.target.value)}
              />
            </Field>
          </div>
        ) : null}
      </div>

      {custom ? (
        <>
          <div className="provider-setup-field-row provider-setup-custom-identity-row">
            <Field label={t("settings.name")}>
              <Input
                ref={nameRef}
                value={name}
                autoFocus
                onChange={(event) => onNameChange(event.target.value)}
              />
            </Field>
            <div className="provider-setup-base-url">
              <Field
                label={t("settings.baseUrl")}
                hint={chatgptStyle ? t("settings.chatgptChatEndpointFixed") : undefined}
              >
                <Input
                  value={baseUrl}
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  disabled={saving || chatgptStyle}
                  className="font-mono text-sm-plus"
                  placeholder="https://api.example.com/v1"
                  aria-invalid={Boolean(baseUrlError)}
                  aria-describedby={baseUrlError ? "provider-base-url-error" : undefined}
                  onChange={(event) => onBaseUrlChange(event.target.value)}
                  onBlur={commitBaseUrl}
                />
                {baseUrlError ? (
                  <div
                    id="provider-base-url-error"
                    className="provider-setup-field-error"
                    role="alert"
                  >
                    {baseUrlError}
                  </div>
                ) : null}
              </Field>
            </div>
          </div>
          <div className="provider-setup-field-row provider-setup-custom-auth-row">
            {chatgptStyle ? (
              <div className="provider-setup-key space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-text-secondary" role="status">
                    {chatgptStatusLabel}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={saving || chatgptBusy || chatgptLoggedIn === null}
                    onClick={() => void changeChatgptLogin()}
                  >
                    {chatgptBusy
                      ? t("settings.chatgptChatWorking")
                      : chatgptLoggedIn
                        ? t("settings.chatgptChatLogout")
                        : t("settings.chatgptChatLogin")}
                  </Button>
                </div>
                {!chatgptLoggedIn ? <Button
                  variant="secondary"
                  size="sm"
                  disabled={saving || chatgptBusy || chatgptLoggedIn === null}
                  onClick={() => void changeChatgptLogin(true)}
                >{t("settings.chatgptChatImportLogin")}</Button> : null}
                {chatgptError || chatgptStatus?.message ? (
                  <p
                    className={`text-xs ${!chatgptError && chatgptStatus?.state === "checking" ? "text-text-secondary" : "text-error"}`}
                    role={!chatgptError && chatgptStatus?.state === "checking" ? "status" : "alert"}
                  >
                    {chatgptError ?? chatgptStatus?.message}
                  </p>
                ) : null}
              </div>
            ) : (
            <div className="provider-setup-key">
              <Field label={t("settings.apiKey")} hint={keyHint}>
                <div className="provider-setup-key-control">
                  <Input
                    ref={apiKeyRef}
                    type="password"
                    value={apiKey}
                    placeholder="sk-…"
                    className="font-mono text-sm-plus"
                    autoComplete="off"
                    disabled={saving}
                    onChange={(event) => onApiKeyChange(event.target.value)}
                  />
                  {hasSavedApiKey && onClearApiKey ? (
                    <TooltipButton
                      type="button"
                      className="icon-btn icon-btn-square"
                      tooltip={t("settings.clearApiKey")}
                      ariaLabel={t("settings.clearApiKey")}
                      disabled={saving}
                      onClick={onClearApiKey}
                    >
                      <IconTrash size={14} aria-hidden />
                    </TooltipButton>
                  ) : null}
                </div>
              </Field>
            </div>
            )}
            <Field
              label={t("settings.apiStyle")}
              hint={apiStyleNote ?? (accountOnlyApiStyle ? t(requiresApiStyleChoice
                ? "settings.apiStyleChooseCustom"
                : "settings.apiStyleLegacyAccount") : undefined)}
            >
              <SettingsMenuSelect
                fullWidth
                label={t("settings.apiStyle")}
                value={apiStyle}
                disabled={saving}
                onChange={(id) => onApiStyleChange(id as CatalogApiStyle)}
                options={[
                  ...(accountOnlyApiStyle
                    ? [{
                        id: apiStyle,
                        label: t(API_STYLE_LABEL_KEYS[apiStyle]),
                        disabled: true,
                      }]
                    : []),
                  ...CUSTOM_PROVIDER_API_STYLES.map((style) => ({
                    id: style,
                    label: t(API_STYLE_LABEL_KEYS[style]),
                  })),
                ]}
              />
            </Field>
          </div>
        </>
      ) : null}
    </div>
  );
}
