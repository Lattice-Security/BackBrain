import React from 'react';

interface ErrorsTabProps {
    errors: string[];
}

export const ErrorsTab: React.FC<ErrorsTabProps> = ({ errors }) => {
    return (
        <div className="bb-tab-content bb-errors-tab">
            <div className="bb-section">
                <h3>Errors</h3>
                {errors.length === 0 ? (
                    <div className="bb-empty-state">No errors recorded.</div>
                ) : (
                    <div className="bb-error-list">
                        {errors.map((error, idx) => (
                            <div key={idx} className="bb-error-card">
                                <span className="bb-error-icon">⚠️</span>
                                <span className="bb-error-text">{error}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
