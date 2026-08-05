import React, { Component, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Global error boundary — catches render errors / network failures
 * so the app shows a readable error screen instead of hanging
 * on a black screen.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: '100vh',
            background: '#0a0a0d',
            color: '#f0f2f8',
            fontFamily: 'Segoe UI, Arial, sans-serif',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2rem',
          }}
        >
          <div
            style={{
              maxWidth: '480px',
              width: '100%',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,84,112,0.3)',
              borderRadius: '20px',
              padding: '2.5rem',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                fontSize: '2.5rem',
                marginBottom: '1rem',
              }}
            >
              ⚠️
            </div>
            <h2
              style={{
                fontSize: '1.3rem',
                fontWeight: 800,
                marginBottom: '0.75rem',
                color: '#FF5470',
              }}
            >
              Что-то пошло не так
            </h2>
            <p
              style={{
                fontSize: '0.85rem',
                color: 'rgba(240,242,248,0.6)',
                lineHeight: 1.6,
                marginBottom: '1.5rem',
                wordBreak: 'break-word',
              }}
            >
              {this.state.error?.message || 'Неизвестная ошибка интерфейса'}
            </p>
            <button
              onClick={this.handleReload}
              style={{
                padding: '0.7rem 1.6rem',
                borderRadius: '12px',
                border: 'none',
                background: 'linear-gradient(135deg, #00c6fb, #8A2BE2)',
                color: '#fff',
                fontSize: '0.9rem',
                fontWeight: 700,
                fontFamily: 'inherit',
                cursor: 'pointer',
                boxShadow: '0 0 20px rgba(0,198,251,0.3)',
              }}
            >
              Перезагрузить
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
