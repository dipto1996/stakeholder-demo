// components/ErrorBoundary.jsx
import React from 'react';

/**
 * Error Boundary Component
 * 
 * Catches React errors and displays a fallback UI instead of crashing the entire app.
 * 
 * Usage in _app.js:
 * import ErrorBoundary from '../components/ErrorBoundary';
 * 
 * <ErrorBoundary>
 *   <Component {...pageProps} />
 * </ErrorBoundary>
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    // Log error to console (in production, send to error tracking service)
    console.error('Error caught by boundary:', error, errorInfo);

    // Update state with error details
    this.state = {
      hasError: true,
      error,
      errorInfo,
    };

    // In production, send to error tracking service (Sentry, LogRocket, etc.)
    if (process.env.NODE_ENV === 'production') {
      // Example: Sentry.captureException(error, { extra: errorInfo });
    }
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#f9fafb',
            fontFamily: 'Inter, system-ui, sans-serif',
            padding: 20,
          }}
        >
          <div
            style={{
              maxWidth: 600,
              width: '100%',
              background: 'white',
              borderRadius: 12,
              padding: 40,
              boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
            }}
          >
            {/* Error Icon */}
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: '50%',
                background: '#fee2e2',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 24px',
              }}
            >
              <svg
                width="32"
                height="32"
                fill="none"
                stroke="#dc2626"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 24 24"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>

            {/* Error Title */}
            <h1
              style={{
                fontSize: 24,
                fontWeight: 700,
                color: '#111',
                textAlign: 'center',
                marginBottom: 12,
              }}
            >
              Oops! Something went wrong
            </h1>

            {/* Error Message */}
            <p
              style={{
                fontSize: 16,
                color: '#666',
                textAlign: 'center',
                marginBottom: 24,
                lineHeight: 1.5,
              }}
            >
              We encountered an unexpected error. Don't worry, your data is safe.
              Try refreshing the page or contact support if the problem persists.
            </p>

            {/* Error Details (Development only) */}
            {process.env.NODE_ENV === 'development' && this.state.error && (
              <details
                style={{
                  marginBottom: 24,
                  padding: 16,
                  background: '#f3f4f6',
                  borderRadius: 8,
                  fontSize: 13,
                  fontFamily: 'monospace',
                }}
              >
                <summary
                  style={{
                    cursor: 'pointer',
                    fontWeight: 600,
                    marginBottom: 8,
                    color: '#374151',
                  }}
                >
                  Error Details (Development Mode)
                </summary>
                <div style={{ color: '#dc2626', marginBottom: 12 }}>
                  <strong>Error:</strong> {this.state.error.toString()}
                </div>
                {this.state.errorInfo && (
                  <pre
                    style={{
                      whiteSpace: 'pre-wrap',
                      wordWrap: 'break-word',
                      color: '#374151',
                      fontSize: 12,
                    }}
                  >
                    {this.state.errorInfo.componentStack}
                  </pre>
                )}
              </details>
            )}

            {/* Action Buttons */}
            <div
              style={{
                display: 'flex',
                gap: 12,
                justifyContent: 'center',
              }}
            >
              <button
                onClick={this.handleReset}
                style={{
                  padding: '12px 24px',
                  background: '#0b63d8',
                  color: 'white',
                  border: 'none',
                  borderRadius: 8,
                  fontSize: 16,
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'background 0.2s',
                }}
                onMouseOver={(e) => (e.target.style.background = '#0952b8')}
                onMouseOut={(e) => (e.target.style.background = '#0b63d8')}
              >
                Try Again
              </button>

              <button
                onClick={() => (window.location.href = '/')}
                style={{
                  padding: '12px 24px',
                  background: 'white',
                  color: '#374151',
                  border: '1px solid #d1d5db',
                  borderRadius: 8,
                  fontSize: 16,
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'background 0.2s',
                }}
                onMouseOver={(e) => (e.target.style.background = '#f9fafb')}
                onMouseOut={(e) => (e.target.style.background = 'white')}
              >
                Go Home
              </button>
            </div>

            {/* Support Link */}
            <div
              style={{
                marginTop: 24,
                paddingTop: 24,
                borderTop: '1px solid #e5e7eb',
                textAlign: 'center',
              }}
            >
              <p style={{ fontSize: 14, color: '#9ca3af' }}>
                Need help?{' '}
                <a
                  href="mailto:support@yourdomain.com"
                  style={{
                    color: '#0b63d8',
                    textDecoration: 'none',
                    fontWeight: 600,
                  }}
                >
                  Contact Support
                </a>
              </p>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;

