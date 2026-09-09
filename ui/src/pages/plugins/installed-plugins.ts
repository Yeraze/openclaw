import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../components/icons.ts";
import { renderSettingsLoadingSkeleton } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import type { PluginCatalogItem, PluginListResult } from "../../lib/plugins/index.ts";
import { renderArtTile } from "./consent-dialog.ts";
import { renderPluginCardIdentity, type PluginCardAttribution } from "./plugin-card.ts";
const INSTALLED_PLUGINS_ROW_LIMIT = 4;
const UNCATEGORIZED = "uncategorized";
const INSTALLED_CATEGORY_ORDER = [
  "channels",
  "models",
  "memory",
  "context",
  "web",
  "voice",
  "media",
  "tools",
  "runtime",
  "gateway",
  "security",
  "other",
] as const;

type InstalledPluginItem = PluginCatalogItem & { categories?: readonly string[] };
type InstalledPluginGroup = {
  category: string;
  plugins: InstalledPluginItem[];
};

const INSTALLED_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  channels: "pluginsPage.categoryChannels",
  models: "pluginsPage.categoryModels",
  memory: "pluginsPage.categoryMemory",
  context: "pluginsPage.categoryContext",
  web: "pluginsPage.categoryWeb",
  voice: "pluginsPage.categoryVoice",
  media: "pluginsPage.categoryMedia",
  tools: "pluginsPage.categoryTools",
  runtime: "pluginsPage.categoryRuntime",
  gateway: "pluginsPage.categoryGateway",
  security: "pluginsPage.categorySecurity",
  other: "pluginsPage.categoryOther",
  uncategorized: "pluginsPage.categoryUncategorized",
};

function installedCategoryLabel(category: string): string {
  const key = INSTALLED_CATEGORY_LABELS[category];
  if (key) {
    return t(key);
  }
  return category
    .split("-")
    .map((part) => `${part.slice(0, 1).toLocaleUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function compareInstalledCategories(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left === UNCATEGORIZED) {
    return 1;
  }
  if (right === UNCATEGORIZED) {
    return -1;
  }
  const leftIndex = INSTALLED_CATEGORY_ORDER.findIndex((category) => category === left);
  const rightIndex = INSTALLED_CATEGORY_ORDER.findIndex((category) => category === right);
  if (leftIndex === -1 || rightIndex === -1) {
    return leftIndex === rightIndex ? left.localeCompare(right) : leftIndex === -1 ? 1 : -1;
  }
  return leftIndex - rightIndex;
}

function groupInstalledPlugins(plugins: readonly InstalledPluginItem[]): InstalledPluginGroup[] {
  const groups = new Map<string, InstalledPluginItem[]>();
  for (const plugin of plugins) {
    const category = plugin.categories?.[0] ?? UNCATEGORIZED;
    const group = groups.get(category) ?? [];
    group.push(plugin);
    groups.set(category, group);
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => compareInstalledCategories(left, right))
    .map(([category, groupedPlugins]) => ({ category, plugins: groupedPlugins }));
}

function installedPluginPriority(plugin: PluginCatalogItem): number {
  if (plugin.state === "error" || plugin.state === "needs-setup") {
    return 0;
  }
  return plugin.enabled ? 1 : 2;
}

/** Actionable plugins lead the collapsed inventory, followed by enabled and disabled groups. */
function prioritizeInstalledPlugins(
  plugins: readonly InstalledPluginItem[],
): InstalledPluginItem[] {
  return plugins
    .filter((plugin) => plugin.installed)
    .toSorted(
      (left, right) =>
        installedPluginPriority(left) - installedPluginPriority(right) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
}

function matchesPlugin(plugin: InstalledPluginItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) {
    return true;
  }
  return [
    plugin.name,
    plugin.id,
    plugin.description,
    ...(plugin.categories ?? []),
    plugin.origin,
    ...(plugin.kind ?? []),
  ].some((value) => value?.toLocaleLowerCase().includes(needle));
}

export type InstalledPluginsProps = {
  connected: boolean;
  loading: boolean;
  result: PluginListResult | null;
  error: string | null;
  expanded: boolean;
  searchOpen: boolean;
  query: string;
  iconUrls: Record<string, string>;
  attributions?: ReadonlyMap<string, PluginCardAttribution>;
  onExpandedChange: (expanded: boolean) => void;
  onSearchOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  settingsHref: (pluginId: string) => string;
  onOpenSettings: (pluginId?: string) => void;
  onIconError: (pluginId: string) => void;
};

function renderCard(plugin: InstalledPluginItem, props: InstalledPluginsProps): TemplateResult {
  const open = () => props.onOpenSettings(plugin.id);
  const attribution = props.attributions?.get(plugin.id) ?? { official: false };
  return html`
    <a
      class="installed-plugins-card oc-card oc-card-interactive"
      data-plugin-id=${plugin.id}
      data-plugin-status=${plugin.state}
      href=${props.settingsHref(plugin.id)}
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        open();
      }}
    >
      <div class="installed-plugins-card__head">
        ${renderArtTile(
          plugin.id,
          plugin.name,
          props.iconUrls[plugin.id],
          () => props.onIconError(plugin.id),
          "installed-plugins-card__art",
        )}
        ${renderPluginCardIdentity({
          name: plugin.name,
          attribution,
          showAuthor: false,
          state: plugin.state === "not-installed" ? undefined : plugin.state,
          subtitle: plugin.description || t("pluginsPage.optionalCapability"),
        })}
      </div>
      ${
        plugin.error
          ? html`<p class="installed-plugins-card__error" role="alert">
              ${formatUiExternalText(plugin.error)}
            </p>`
          : nothing
      }
    </a>
  `;
}

export function renderInstalledPlugins(props: InstalledPluginsProps): TemplateResult {
  const installed = prioritizeInstalledPlugins(props.result?.plugins ?? []);
  const filtered = props.searchOpen
    ? installed.filter((plugin) => matchesPlugin(plugin, props.query))
    : installed;
  const groups = groupInstalledPlugins(filtered);
  const closeSearch = (source: Element) => {
    const actions = source.closest(".installed-plugins__actions");
    props.onSearchOpenChange(false);
    queueMicrotask(() => {
      actions?.querySelector<HTMLButtonElement>(".installed-plugins__search-trigger")?.focus();
    });
  };

  return html`
    <section class="installed-plugins" aria-labelledby="installed-plugins-title">
      <header class="installed-plugins__header">
        <div>
          <h2 id="installed-plugins-title">${t("pluginsPage.installedPluginsTitle")}</h2>
        </div>
        <div class="installed-plugins__actions">
          ${
            props.searchOpen
              ? html`<div class="installed-plugins__search">
                  <span class="installed-plugins__search-icon" aria-hidden="true"
                    >${icons.search}</span
                  >
                  <input
                    type="search"
                    class="oc-input"
                    aria-label=${t("pluginsPage.searchLabel")}
                    .value=${props.query}
                    placeholder=${t("pluginsPage.searchInstalledPlaceholder")}
                    ${ref((element) => {
                      if (
                        element instanceof HTMLInputElement &&
                        document.activeElement !== element
                      ) {
                        queueMicrotask(() => {
                          if (element.isConnected) {
                            element.focus();
                          }
                        });
                      }
                    })}
                    @input=${(event: Event) => {
                      if (event.currentTarget instanceof HTMLInputElement) {
                        props.onQueryChange(event.currentTarget.value);
                      }
                    }}
                    @keydown=${(event: KeyboardEvent) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        if (event.currentTarget instanceof HTMLInputElement) {
                          closeSearch(event.currentTarget);
                        }
                      }
                    }}
                  />
                  <button
                    type="button"
                    class="btn btn--xs btn--icon installed-plugins__icon-action installed-plugins__search-close oc-action oc-action-icon oc-action-ghost"
                    aria-label=${t("common.close")}
                    @click=${(event: MouseEvent) => {
                      if (event.currentTarget instanceof HTMLElement) {
                        closeSearch(event.currentTarget);
                      }
                    }}
                  >
                    ${icons.x}
                  </button>
                </div>`
              : html`<button
                  type="button"
                  class="btn btn--sm btn--icon installed-plugins__icon-action installed-plugins__search-trigger oc-action oc-action-icon oc-action-ghost"
                  aria-label=${t("pluginsPage.searchLabel")}
                  aria-expanded="false"
                  @click=${() => props.onSearchOpenChange(true)}
                >
                  ${icons.search}
                </button>`
          }
          <button
            type="button"
            class="btn btn--sm btn--icon installed-plugins__icon-action oc-action oc-action-icon oc-action-ghost"
            aria-label=${t("pluginsPage.pluginSettings")}
            @click=${() => props.onOpenSettings()}
          >
            ${icons.settings}
          </button>
        </div>
      </header>
      ${
        props.loading
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
              ? html`<p class="plugin-catalog-results__empty">${t("pluginsPage.offlineBody")}</p>`
              : filtered.length === 0
                ? html`<p class="plugin-catalog-results__empty">
                    ${
                      props.query
                        ? t("pluginsPage.noInstalledMatchTitle")
                        : t("pluginsPage.noInstalledTitle")
                    }
                  </p>`
                : html`<div class="installed-plugins__groups">
                    ${repeat(
                      groups,
                      (group) => group.category,
                      (group) => html`
                        <section
                          class=${`installed-plugins__group ${
                            props.searchOpen || props.expanded ? "is-expanded" : ""
                          }`}
                          data-plugin-category=${group.category}
                        >
                          <header class="installed-plugins__group-header">
                            <h3>${installedCategoryLabel(group.category)}</h3>
                            <button
                              type="button"
                              class="btn btn--sm installed-plugins__group-action oc-action oc-action-ghost"
                              @click=${() => props.onExpandedChange(!props.expanded)}
                            >
                              ${
                                props.expanded
                                  ? t("pluginsPage.hideInstalledPlugins")
                                  : t("pluginsPage.viewAllInstalledPlugins")
                              }
                            </button>
                          </header>
                          <div class="installed-plugins__grid">
                            ${repeat(
                              props.searchOpen || props.expanded
                                ? group.plugins
                                : group.plugins.slice(0, INSTALLED_PLUGINS_ROW_LIMIT),
                              (plugin) => plugin.id,
                              (plugin) => renderCard(plugin, props),
                            )}
                          </div>
                        </section>
                      `,
                    )}
                  </div>`
      }
    </section>
  `;
}
