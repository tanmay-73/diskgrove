import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer crashed', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            color: '#e8eef6',
            background: '#0c1017',
            height: '100%',
            fontFamily: 'Segoe UI, sans-serif'
          }}
        >
          <h1 style={{ fontSize: 20, marginBottom: 12 }}>DiskGrove failed to start</h1>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#f07171' }}>{this.state.error.message}</pre>
          <p style={{ marginTop: 16, color: '#93a0b5' }}>Close this window and run npm run dev again.</p>
        </div>
      )
    }
    return this.props.children
  }
}
