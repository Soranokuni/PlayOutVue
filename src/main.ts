import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import App from './App.vue'
import { recordFrontendFault } from './lib/frontendFaults'

const app = createApp(App)

// Audit T1-12: an unhandled error or rejection in an event handler used to
// vanish (or, for render errors, unmount the tree). Route everything to the
// console and the Rust diagnostics log so an on-air fault leaves evidence.
const reportFrontendFault = (source: string, error: unknown, extra?: string) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
  console.error(`[${source}]`, message, extra ?? '')
  recordFrontendFault(source, extra ? `${extra}: ${message}` : message)
  void import('@tauri-apps/api/core')
    .then(({ invoke }) =>
      invoke('push_diagnostic_log', {
        level: 'error',
        scope: `frontend:${source}`,
        message: extra ? `${extra} :: ${message}` : message
      })
    )
    .catch(() => {
      /* diagnostics unavailable (dev server / tests) */
    })
}

app.config.errorHandler = (error, _instance, info) => {
  reportFrontendFault('vue', error, info)
}

if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    reportFrontendFault('unhandledrejection', event.reason)
  })
  window.addEventListener('error', (event) => {
    reportFrontendFault('window.error', event.error ?? event.message)
  })
}

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

app.use(pinia)

app.mount('#app')
