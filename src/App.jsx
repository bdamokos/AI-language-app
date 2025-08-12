import React from 'react';
import SpanishPracticeApp from './SpanishPracticeApp.jsx';
import SettingsPanel from './SettingsPanel.jsx';

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="py-6">
        <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <SpanishPracticeApp />
          </div>
          <div>
            <SettingsPanel />
          </div>
        </div>
      </div>
    </div>
  );
}


