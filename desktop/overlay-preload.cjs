const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktop',Object.freeze({
  onOverlay(callback){const listener=(_event,payload)=>callback(payload);ipcRenderer.on('overlay:state',listener);return()=>ipcRenderer.removeListener('overlay:state',listener);},
}));
