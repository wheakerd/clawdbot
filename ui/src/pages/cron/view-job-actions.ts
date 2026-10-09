import { html, nothing } from "lit";
import type { CronJob } from "../../api/types.ts";
import { icon } from "../../components/icons.ts";
import { renderSettingsToggle } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { CronProps } from "./view-types.ts";

export function renderJobMenu(props: CronProps, job: CronJob) {
  if (!props.canManage) {
    return nothing;
  }
  const displayName = job.displayName ?? job.name;
  return html`
    <wa-dropdown
      class="cron-job-menu"
      placement="bottom-end"
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        if (!props.canManage) {
          return;
        }
        switch (event.detail.item.value) {
          case "run-if-due":
            props.onRun(job, "due");
            break;
          case "clone":
            props.onClone(job);
            break;
          case "remove":
            props.onRemove(job);
            break;
          case undefined:
            break;
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="btn btn--sm btn--ghost cron-job-menu__trigger"
        aria-label=${t("cron.actions.moreJob", { name: displayName })}
        title=${t("cron.actions.moreJob", { name: displayName })}
      >
        ${icon("moreHorizontal")}
      </button>
      ${renderMenuItem(props, "run-if-due", t("cron.actions.runIfDue"))}
      ${renderMenuItem(props, "clone", t("cron.actions.clone"))}
      ${renderMenuItem(props, "remove", t("cron.actions.remove"), true)}
    </wa-dropdown>
  `;
}

export function renderEnabledSwitch(props: CronProps, job: CronJob, compact = false) {
  const stateLabel = job.enabled ? t("cron.detail.active") : t("cron.detail.paused");
  const actionLabel = t(job.enabled ? "cron.actions.pauseJob" : "cron.actions.resumeJob", {
    name: job.displayName ?? job.name,
  });
  return html`
    <span
      class="cron-enabled-toggle"
      data-test-id=${compact ? `cron-row-toggle-${job.id}` : "cron-toggle-enabled"}
      title=${compact ? actionLabel : nothing}
    >
      ${renderSettingsToggle({
        checked: job.enabled,
        disabled: props.busy || !props.canManage,
        ariaLabel: compact ? actionLabel : stateLabel,
        onChange: (checked) => {
          if (props.canManage) {
            props.onToggle(job, checked);
          }
        },
      })}
      ${compact ? nothing : html`<span class="cron-detail-sub">${stateLabel}</span>`}
    </span>
  `;
}

function renderMenuItem(props: CronProps, value: string, label: string, danger = false) {
  return html`
    <wa-dropdown-item
      class=${danger ? "cron-job-menu__item danger" : "cron-job-menu__item"}
      value=${value}
      variant=${danger ? "danger" : "default"}
      ?disabled=${props.busy || !props.canManage}
    >
      ${label}
    </wa-dropdown-item>
  `;
}
