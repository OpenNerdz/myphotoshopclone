import { App } from './app.js';
import { toast } from './toast.js';

const app = new App();
// Exposed for debugging and automated tests.
window.overlayStudio = app;

app.init().catch((err) => {
    console.error(err);
    toast('Something went wrong while starting the editor. Please reload the page.', { type: 'error', duration: 0 });
});

window.addEventListener('error', (e) => console.error('Uncaught error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('Unhandled rejection', e.reason));

// Offline support. Only on https so local development always gets fresh files.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker registration failed', err));
    });
}
