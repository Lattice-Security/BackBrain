import { Component, type ErrorInfo, type ReactNode } from 'react';
import { vscode } from '../messages';
import './ErrorBoundary.css';

// ============================================================
// ErrorCard — structured error display
// ============================================================

type ErrorCardType = 'auth' | 'rate-limit' | 'network' | 'generic';

function classifyError(raw: string): ErrorCardType {
    const lower = raw.toLowerCase();
    if (lower.includes('auth') || lower.includes('authenticated') || lower.includes('credentials')) {
        return 'auth';
    }
    if (lower.includes('rate') || lower.includes('429') || lower.includes('quota') || lower.includes('capacity')) {
        return 'rate-limit';
    }
    if (lower.includes('network') || lower.includes('econnrefused') || lower.includes('connection')) {
        return 'network';
    }
    return 'generic';
}

interface ErrorCardProps {
    error: string;
    onRetry?: () => void;
    onChangeDepth?: () => void;
}

export function ErrorCard({ error, onRetry, onChangeDepth }: ErrorCardProps) {
    const kind = classifyError(error);

    if (kind === 'auth') {
        return (
            <div className="error-card error-card--red">
                <div className="error-card__header">
                    <span className="error-card__icon">⚠</span>
                    <span className="error-card__title">Gemini not authenticated</span>
                </div>
                <p className="error-card__message">
                    Gemini CLI cannot find its credentials. Run this command in your terminal then reload VS Code.
                </p>
                <pre className="error-card__code">gemini auth</pre>
                <div className="error-card__actions">
                    <button
                        className="error-card__button error-card__button--primary"
                        onClick={() => vscode.postMessage({ type: 'reloadWindow' } as any)}
                    >
                        Reload Window
                    </button>
                </div>
            </div>
        );
    }

    if (kind === 'rate-limit') {
        return (
            <div className="error-card error-card--amber">
                <div className="error-card__header">
                    <span className="error-card__icon">⏱</span>
                    <span className="error-card__title">Rate limit reached</span>
                </div>
                <p className="error-card__message">
                    Gemini free tier quota exhausted. Switch to a lower scan depth or wait a moment and retry.
                </p>
                <div className="error-card__actions">
                    {onChangeDepth && (
                        <button className="error-card__button" onClick={onChangeDepth}>
                            Change Depth
                        </button>
                    )}
                    {onRetry && (
                        <button className="error-card__button error-card__button--primary" onClick={onRetry}>
                            Retry
                        </button>
                    )}
                </div>
            </div>
        );
    }

    if (kind === 'network') {
        return (
            <div className="error-card error-card--amber">
                <div className="error-card__header">
                    <span className="error-card__icon">⚡</span>
                    <span className="error-card__title">Connection error</span>
                </div>
                <p className="error-card__message">
                    Cannot reach Gemini. Check your internet connection and try again.
                </p>
                <div className="error-card__actions">
                    {onRetry && (
                        <button className="error-card__button error-card__button--primary" onClick={onRetry}>
                            Retry
                        </button>
                    )}
                </div>
            </div>
        );
    }

    // Generic
    return (
        <div className="error-card error-card--red">
            <div className="error-card__header">
                <span className="error-card__icon">✕</span>
                <span className="error-card__title">Unexpected error</span>
            </div>
            <p className="error-card__message">Details: {error}</p>
            <div className="error-card__actions">
                {onRetry && (
                    <button className="error-card__button error-card__button--primary" onClick={onRetry}>
                        Retry
                    </button>
                )}
            </div>
        </div>
    );
}

// ============================================================
// ErrorBoundary
// ============================================================

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}

interface State {
    hasError: boolean;
    error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('ErrorBoundary caught:', error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            return this.props.fallback || (
                <div className="error-boundary">
                    <ErrorCard
                        error={this.state.error?.message || 'An unexpected error occurred in the BackBrain panel.'}
                        onRetry={() => this.setState({ hasError: false })}
                    />
                    <div className="error-boundary__hint">
                        This may be caused by a rendering error in the extension UI. Try reloading the panel or the window.
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
