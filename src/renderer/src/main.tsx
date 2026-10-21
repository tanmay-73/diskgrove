import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './error-boundary'
import './index.css'

// Never let a dropped file or link navigate the window away from the app.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (event) => event.preventDefault())
}

const root = document.getElementById('root')
if (!root) {
  document.body.textContent = 'DiskGrove could not find the root element.'
} else {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>
  )
}
