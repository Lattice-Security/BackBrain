import React from 'react';
import { vscode } from '../messages';

interface ScanTabProps {
    scanDepth: string;
    selectedBackend: string;
    loading: boolean;
    scanStatus: any;
    batchProgress: any;
    scanners: Array<{ name: string; enabled: boolean }>;
    backends: Array<{ id: string; label: string }>;
}

export const ScanTab: React.FC<ScanTabProps> = ({
    scanDepth, selectedBackend, loading, scanStatus, batchProgress, scanners, backends
}) => {
    return (
        <div className="bb-tab-content bb-scan-tab">
            <div className="bb-section">
                <h3>Scan Target</h3>
                <div className="bb-scan-actions">
                    <button 
                        className="bb-primary-btn" 
                        disabled={loading} 
                        onClick={() => vscode.postMessage({ type: 'requestScan' })}
                    >
                        Scan Workspace
                    </button>
                    <button 
                        className="bb-secondary-btn" 
                        disabled={loading} 
                        onClick={() => vscode.postMessage({ type: 'requestScanFile' })}
                    >
                        Scan Active File
                    </button>
                </div>
            </div>

            <div className="bb-section">
                <h3>Scan Depth</h3>
                <select 
                    value={scanDepth} 
                    onChange={e => vscode.postMessage({ type: 'setScanDepth', depth: e.target.value as any })}
                    disabled={loading}
                    className="bb-select"
                >
                    <option value="developer">Developer</option>
                    <option value="team">Team</option>
                    <option value="security">Security</option>
                    <option value="audit">Audit</option>
                </select>
            </div>

            <div className="bb-section">
                <h3>Scanners</h3>
                <div className="bb-scanner-list">
                    {scanners.map(s => (
                        <label key={s.name} className="bb-checkbox-label">
                            <input 
                                type="checkbox" 
                                checked={s.enabled} 
                                disabled={loading}
                                onChange={e => vscode.postMessage({ 
                                    type: 'setScannerEnabled', 
                                    scanner: s.name, 
                                    enabled: e.target.checked 
                                })}
                            />
                            {s.name}
                        </label>
                    ))}
                    {scanners.length === 0 && <span className="bb-empty-text">No scanners available</span>}
                </div>
            </div>

            <div className="bb-section">
                <h3>AI Backend</h3>
                <select 
                    value={selectedBackend} 
                    onChange={e => vscode.postMessage({ type: 'setAgentBackend', backend: e.target.value as any })}
                    disabled={loading}
                    className="bb-select"
                >
                    {backends.map(b => (
                        <option key={b.id} value={b.id}>{b.label}</option>
                    ))}
                    {backends.length === 0 && <option value="gemini">Gemini</option>}
                </select>
            </div>

            {loading && (
                <div className="bb-section bb-progress-section">
                    <h3>Progress</h3>
                    <div className="scan-progress">
                        <div className="scan-progress__phase-label">
                            {scanStatus?.message || 'Scanning...'}
                        </div>
                        <div className="scan-progress__sub-label">
                            {scanStatus?.scanner || scanStatus?.backend || ''}
                        </div>
                        {batchProgress && (
                            <div className="scan-progress__track">
                                <div
                                    className="scan-progress__bar"
                                    style={{ width: `${(batchProgress.current / batchProgress.total) * 100}%` }}
                                />
                            </div>
                        )}
                        {!batchProgress && (
                            <div className="scan-progress__spinner">
                                <vscode-progress-ring />
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
