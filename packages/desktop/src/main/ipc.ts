import { BrowserWindow, ipcMain } from 'electron';

export function setupIpcHandlers() {
  ipcMain.on('window-minimize', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      win.minimize();
    }
  });

  ipcMain.on('window-maximize', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  ipcMain.on('window-close', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      win.close();
    }
  });
}
