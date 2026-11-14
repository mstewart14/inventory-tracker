import type { Shell } from "../shell";
import type { Api } from "../lib/api";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { Page } from "./Page";
import { PrintCodes } from "./PrintCodes";

interface Props {
  store: Store;
  api: Api;
  shell: Shell;
}

/** A sheet of unassigned codes on label sheets. Administrator only (S-BOOT-02). */
export function SettingsCodes({ store, api, shell }: Props) {
  useStore(store);

  if (!store.admin) {
    return (
      <Page title="Not found" back="/settings">
        <p>Administrators only.</p>
      </Page>
    );
  }

  return (
    <Page title="Print QR codes" back="/settings">
      <PrintCodes api={api} onDone={shell.sync} />
    </Page>
  );
}
