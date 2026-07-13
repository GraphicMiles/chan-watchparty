import React from 'react'

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(this.state.error, () => this.setState({ hasError: false, error: null }))
      }
      if (this.props.fallback) {
        return this.props.fallback
      }
      return (
        <div style={{
          padding: '16px',
          margin: '12px 0',
          background: 'rgba(234, 51, 35, 0.08)',
          border: '1px solid rgba(234, 51, 35, 0.25)',
          borderRadius: '12px',
          color: '#EA3323',
          fontSize: '13px',
          textAlign: 'center',
        }}>
          <p style={{ margin: '0 0 8px', fontWeight: 600 }}>Something went wrong loading this section.</p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '6px 14px',
              borderRadius: '999px',
              background: '#EA3323',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 600,
            }}
          >
            Retry Section
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
