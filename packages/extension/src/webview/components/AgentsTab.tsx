import React, { useState } from 'react';
import type { IssueData } from '../messages';
import { IssueItem } from './IssueItem';

interface AgentsTabProps {
    specialists: Array<{ name: string; backend: string; focus: string; findings: IssueData[] }>;
    onClearActiveFix: () => void;
}

export const AgentsTab: React.FC<AgentsTabProps> = ({ specialists, onClearActiveFix }) => {
    const [expandedSpecialists, setExpandedSpecialists] = useState<Record<string, boolean>>({});

    const toggleSpecialist = (name: string) => {
        setExpandedSpecialists(prev => ({
            ...prev,
            [name]: !prev[name]
        }));
    };

    const totalFindings = specialists.reduce((acc, s) => acc + s.findings.length, 0);

    return (
        <div className="bb-tab-content bb-agents-tab">
            <div className="bb-agents-summary">
                <div className="bb-stat-card">
                    <div className="bb-stat-value">{specialists.length}</div>
                    <div className="bb-stat-label">Agents Ran</div>
                </div>
                <div className="bb-stat-card">
                    <div className="bb-stat-value">{totalFindings}</div>
                    <div className="bb-stat-label">Total Findings</div>
                </div>
            </div>

            <div className="bb-specialist-list">
                {specialists.length === 0 && (
                    <div className="bb-empty-state">No agents have run yet.</div>
                )}
                
                {specialists.map(specialist => {
                    const isExpanded = expandedSpecialists[specialist.name] || false;
                    
                    return (
                        <div key={specialist.name} className="bb-specialist-card">
                            <div className="bb-specialist-header" onClick={() => toggleSpecialist(specialist.name)}>
                                <div className="bb-specialist-info">
                                    <span className="bb-specialist-name">{specialist.name}</span>
                                    <span className="bb-specialist-badge">{specialist.findings.length} findings</span>
                                </div>
                                <button className={`issue-chevron ${isExpanded ? 'issue-chevron--open' : ''}`}>›</button>
                            </div>
                            
                            {isExpanded && (
                                <div className="bb-specialist-body">
                                    <div className="bb-specialist-meta">
                                        <span>Backend: {specialist.backend}</span>
                                        <span>Focus: {specialist.focus}</span>
                                    </div>
                                    <div className="bb-specialist-findings">
                                        {specialist.findings.length === 0 ? (
                                            <div className="bb-empty-text">No findings</div>
                                        ) : (
                                            specialist.findings.map(finding => (
                                                <IssueItem
                                                    key={finding.id}
                                                    issue={finding}
                                                    activeFix={null}
                                                    explanation={null}
                                                    onClearActiveFix={onClearActiveFix}
                                                />
                                            ))
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
