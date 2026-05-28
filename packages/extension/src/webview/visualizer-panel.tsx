import React from 'react';
import ReactDOM from 'react-dom/client';
import { Visualizer } from './components/Visualizer';
import type { IssueData } from './messages';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/theme.css';

function VisualizerPanel() {
    const [issues, setIssues] = React.useState<IssueData[]>([]);

    React.useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data;
            if (msg.type === 'graphData' && msg.issues) {
                setIssues(msg.issues);
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, []);

    return <Visualizer issues={issues} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <ErrorBoundary>
            <VisualizerPanel />
        </ErrorBoundary>
    </React.StrictMode>
);
