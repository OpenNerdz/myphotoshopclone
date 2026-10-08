// Classic (non-module) script: explains why the app can't start when opened
// from the file system or in a browser without ES module support.
(function () {
    var notice = document.getElementById('compatNotice');
    if (!notice) return;
    var message = '';
    if (location.protocol === 'file:') {
        message = 'Image Overlay Studio needs to be served over http(s). Run "npm start" (or "python3 -m http.server") in the project folder, then open the printed address.';
    } else if (!('noModule' in HTMLScriptElement.prototype)) {
        message = 'Your browser is too old to run Image Overlay Studio. Please update to a current version of Chrome, Edge, Firefox or Safari.';
    }
    if (message) {
        notice.textContent = message;
        notice.hidden = false;
    }
})();
