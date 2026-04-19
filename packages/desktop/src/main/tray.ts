import { type BrowserWindow, Menu, Tray, app, nativeImage } from "electron";

let tray: Tray | null = null;

export function createTray(win: BrowserWindow | null) {
	if (tray) {
		return tray;
	}

	// Create an empty native image for the tray icon as a placeholder
	const icon = nativeImage.createEmpty();
	tray = new Tray(icon);

	const contextMenu = Menu.buildFromTemplate([
		{
			label: "Show App",
			click: () => {
				if (win) {
					win.show();
					win.focus();
				}
			},
		},
		{ type: "separator" },
		{
			label: "Quit",
			click: () => {
				app.quit();
			},
		},
	]);

	tray.setToolTip("Octopus AI");
	tray.setContextMenu(contextMenu);

	tray.on("click", () => {
		if (win) {
			if (win.isVisible()) {
				win.hide();
			} else {
				win.show();
				win.focus();
			}
		}
	});

	return tray;
}
