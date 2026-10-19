const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codeAssistant', {
  bootstrap: () => ipcRenderer.invoke('assistant:bootstrap'),
  openWorkspace: () => ipcRenderer.invoke('assistant:open-workspace'),
  request: (method, path, body) => ipcRenderer.invoke('assistant:request', { method, path, body }),
  watchTask: (taskId, after = 0) => ipcRenderer.invoke('assistant:watch', { taskId, after }),
  unwatchTask: (taskId) => ipcRenderer.invoke('assistant:unwatch', taskId),
  onEvent: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('assistant:event', listener);
    return () => ipcRenderer.removeListener('assistant:event', listener);
  },
});
