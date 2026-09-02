import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../components/icons.ts";
import { renderReasonedDisabledControl } from "../../components/reasoned-disabled-control.ts";
import {
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsPage,
  renderSettingsToggle,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import type {
  PluginCatalogItem,
  PluginListResult,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import {
  renderArtTile,
  renderPluginConsentDialog,
  type PluginConsentState,
} from "./consent-dialog.ts";
import type { PluginRowMessage } from "./view.ts";

const YOUR_PLUGINS_INITIAL_LIMIT = 12;

function existingCatalogOrder(left: PluginCatalogItem, right: PluginCatalogItem): number {
  const featured = Number(Boolean(right.featured)) - Number(Boolean(left.featured));
  if (featured !== 0) {
    return featured;
  }
  if (left.featured && right.featured) {
    if (left.featuredAt === undefined && right.featuredAt !== undefined) {
      return 1;
    }
    if (left.featuredAt !== undefined && right.featuredAt === undefined) {
      return -1;
    }
    if (left.featuredAt !== undefined && right.featuredAt !== undefined) {
      const featuredAt = right.featuredAt - left.featuredAt;
      if (featuredAt !== 0) {
        return featuredAt;
      }
    }
  }
  return (
    (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
    left.name.localeCompare(right.name)
  );
}

function runtimePriority(plugin: PluginCatalogItem): number {
  if (plugin.enabled) {
    return 0;
  }
  if (plugin.state === "needs-setup") {
    return 1;
  }
  return plugin.state === "error" ? 2 : 3;
}

/** Actionable state owns inventory order; catalog metadata keeps ties deterministic. */
function prioritizeYourPlugins(plugins: readonly PluginCatalogItem[]): PluginCatalogItem[] {
  return plugins
    .filter((plugin) => plugin.installed)
    .toSorted(
      (left, right) =>
        runtimePriority(left) - runtimePriority(right) || existingCatalogOrder(left, right),
    );
}

function matchesPlugin(plugin: PluginCatalogItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) {
    return true;
  }
  return [
    plugin.name,
    plugin.id,
    plugin.description,
    plugin.category,
    plugin.origin,
    ...(plugin.kind ?? []),
  ].some((value) => value?.toLocaleLowerCase().includes(needle));
}

function fromInteractiveChild(event: Event): boolean {
  return (
    event.target instanceof Element && Boolean(event.target.closest("button, a, input, wa-switch"))
  );
}

export type YourPluginsProps = {
  connected: boolean;
  loading: boolean;
  result: PluginListResult | null;
  error: string | null;
  expanded: boolean;
  searchOpen: boolean;
  query: string;
  busy: Record<string, boolean>;
  messages: Record<string, PluginRowMessage>;
  iconUrls: Record<string, string>;
  canMutate: boolean;
  mutationBlockedReason: string | null;
  consent: PluginConsentState | null;
  consentInspection: PluginsInspectResult | null;
  consentInspectionLoading: boolean;
  consentInspectionError: string | null;
  onExpandedChange: (expanded: boolean) => void;
  onSearchOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onOpenSettings: (pluginId?: string) => void;
  onSetEnabled: (pluginId: string, enabled: boolean, rowKey: string) => void;
  onIconError: (pluginId: string) => void;
  onCancelConsent: () => void;
  onConfirmConsent: () => void;
  onRetryConsentInspection: () => void;
};

function renderToggle(plugin: PluginCatalogItem, rowKey: string, props: YourPluginsProps) {
  const busy = Boolean(props.busy[rowKey]);
  const blockedReason =
    plugin.state === "needs-setup"
      ? t("pluginsPage.setupRequiredEnableBlocked")
      : props.mutationBlockedReason;
  const toggle = renderSettingsToggle({
    checked: plugin.enabled,
    disabled: !blockedReason && (!props.canMutate || busy),
    ariaLabel: t(plugin.enabled ? "pluginsPage.disableNamed" : "pluginsPage.enableNamed", {
      name: plugin.name,
    }),
    ariaDisabled: Boolean(blockedReason),
    onChange: (enabled) => {
      if (blockedReason || !props.canMutate || busy) {
        return false;
      }
      props.onSetEnabled(plugin.id, enabled, rowKey);
      // The catalog response is authoritative; keep the switch at the recorded
      // value until the mutation refresh commits the new plugin state.
      return false;
    },
  });
  return renderReasonedDisabledControl(blockedReason, toggle);
}

function renderCard(plugin: PluginCatalogItem, props: YourPluginsProps): TemplateResult {
  const rowKey = `plugin:${plugin.id}`;
  const message = props.messages[rowKey];
  const open = () => props.onOpenSettings(plugin.id);
  return html`
    <article
      class="your-plugins-card oc-card oc-card-interactive"
      data-plugin-id=${plugin.id}
      data-plugin-status=${plugin.state}
      @click=${(event: Event) => {
        if (!fromInteractiveChild(event)) {
          open();
        }
      }}
    >
      <div class="your-plugins-card__head">
        ${renderArtTile(
          plugin.id,
          plugin.name,
          props.iconUrls[plugin.id],
          () => props.onIconError(plugin.id),
          "your-plugins-card__art",
        )}
        <div class="your-plugins-card__identity">
          <h3>
            <button
              type="button"
              class="your-plugins-card__link"
              aria-label=${t("pluginsPage.openPluginSettings", { name: plugin.name })}
              @click=${open}
            >
              ${plugin.name}
            </button>
          </h3>
          <p>${plugin.description || t("pluginsPage.optionalCapability")}</p>
        </div>
        <div
          class="your-plugins-card__toggle"
          @click=${(event: Event) => event.stopPropagation()}
          @keydown=${(event: Event) => event.stopPropagation()}
        >
          ${renderToggle(plugin, rowKey, props)}
        </div>
      </div>
      ${plugin.error
        ? html`<p class="your-plugins-card__error" role="alert">
            ${formatUiExternalText(plugin.error)}
          </p>`
        : plugin.state === "needs-setup"
          ? html`<p class="your-plugins-card__message your-plugins-card__message--warning">
              ${t("pluginsPage.setupRequired")}
            </p>`
          : nothing}
      ${message
        ? html`<p
            class="your-plugins-card__message your-plugins-card__message--${message.kind}"
            role=${message.kind === "error" ? "alert" : "status"}
          >
            ${message.text}
          </p>`
        : nothing}
    </article>
  `;
}

export function renderYourPlugins(props: YourPluginsProps): TemplateResult {
  const installed = prioritizeYourPlugins(props.result?.plugins ?? []);
  const filtered = props.searchOpen
    ? installed.filter((plugin) => matchesPlugin(plugin, props.query))
    : installed;
  const visible =
    props.searchOpen || props.expanded ? filtered : filtered.slice(0, YOUR_PLUGINS_INITIAL_LIMIT);
  const consentKey = props.consent
    ? props.consent.intent.kind === "install"
      ? props.consent.intent.installIdentity
      : props.consent.intent.rowKey
    : null;

  return html`${renderSettingsPage(
    html`
      <section class="your-plugins" aria-labelledby="your-plugins-title">
        <header class="your-plugins__header">
          <div>
            <h2 id="your-plugins-title">${t("pluginsPage.yourPluginsTitle")}</h2>
          </div>
          <div class="your-plugins__actions">
            <button
              type="button"
              class="btn btn--sm btn--icon oc-action oc-action-icon oc-action-ghost"
              aria-label=${t("pluginsPage.searchLabel")}
              title=${t("pluginsPage.searchLabel")}
              aria-expanded=${props.searchOpen ? "true" : "false"}
              @click=${() => props.onSearchOpenChange(!props.searchOpen)}
            >
              ${icons.search}
            </button>
            <button
              type="button"
              class="btn btn--sm btn--icon oc-action oc-action-icon oc-action-ghost"
              aria-label=${t("pluginsPage.pluginSettings")}
              title=${t("pluginsPage.pluginSettings")}
              @click=${() => props.onOpenSettings()}
            >
              ${icons.settings}
            </button>
          </div>
        </header>
        ${props.searchOpen
          ? html`<label class="plugins-field your-plugins__search">
              <span>${t("pluginsPage.searchLabel")}</span>
              <input
                type="search"
                class="oc-input"
                .value=${props.query}
                placeholder=${t("pluginsPage.searchInstalledPlaceholder")}
                @input=${(event: Event) => {
                  if (event.currentTarget instanceof HTMLInputElement) {
                    props.onQueryChange(event.currentTarget.value);
                  }
                }}
              />
            </label>`
          : nothing}
        ${props.loading
          ? renderSettingsLoadingSkeleton({
              label: t("pluginsPage.loading"),
              rows: 6,
              carapace: true,
            })
          : props.error
            ? html`<div class="callout danger oc-banner oc-banner-error" role="alert">
                <span>${props.error}</span>
                <button
                  type="button"
                  class="btn btn--sm oc-action oc-action-secondary oc-banner-action"
                  @click=${props.onRefresh}
                >
                  ${t("pluginsPage.tryAgain")}
                </button>
              </div>`
            : !props.connected
              ? renderSettingsEmpty(t("pluginsPage.offlineBody"), { carapace: true })
              : visible.length === 0
                ? renderSettingsEmpty(
                    props.query
                      ? t("pluginsPage.noInstalledMatchTitle")
                      : t("pluginsPage.noInstalledTitle"),
                    { carapace: true },
                  )
                : html`<div class="your-plugins__grid">
                    ${repeat(
                      visible,
                      (plugin) => plugin.id,
                      (plugin) => renderCard(plugin, props),
                    )}
                  </div>`}
        ${!props.searchOpen && (installed.length > YOUR_PLUGINS_INITIAL_LIMIT || props.expanded)
          ? html`<div class="your-plugins__more">
              <button
                type="button"
                class="btn btn--sm oc-action oc-action-secondary"
                @click=${() => props.onExpandedChange(!props.expanded)}
              >
                ${props.expanded
                  ? t("pluginsPage.backToYourPlugins")
                  : t("pluginsPage.showAllPlugins", { count: String(installed.length) })}
              </button>
            </div>`
          : nothing}
      </section>
    `,
    { wide: true, carapace: true },
  )}
  ${props.consent
    ? renderPluginConsentDialog({
        consent: props.consent,
        inspection: props.consentInspection,
        loading: props.consentInspectionLoading,
        error: props.consentInspectionError,
        iconUrl: props.consent.pluginId ? props.iconUrls[props.consent.pluginId] : undefined,
        canMutate: props.canMutate,
        mutationBlockedReason: props.mutationBlockedReason,
        busy: consentKey ? Boolean(props.busy[consentKey]) : false,
        onCancel: props.onCancelConsent,
        onConfirm: props.onConfirmConsent,
        onRetry: props.onRetryConsentInspection,
      })
    : nothing}`;
}
