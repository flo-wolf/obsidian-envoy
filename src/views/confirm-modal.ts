import { type App, Modal, Setting } from "obsidian";

/** Asks a yes/no question in an Obsidian dialog. Resolves true when confirmed. */
export function confirmAction(
  app: App,
  options: { title: string; text: string; confirm: string; destructive?: boolean },
): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const modal = new Modal(app);
    modal.setTitle(options.title);
    modal.setContent(options.text);
    new Setting(modal.contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => {
          modal.close();
        }),
      )
      .addButton((button) => {
        button.setButtonText(options.confirm).onClick(() => {
          answered = true;
          modal.close();
        });
        if (options.destructive) {
          button.setDestructive();
        } else {
          button.setCta();
        }
      });
    modal.onClose = () => resolve(answered);
    modal.open();
  });
}
