import React, { useState } from 'react';
import SpanishPracticeApp from './SpanishPracticeApp.jsx';
import SettingsPanel from './SettingsPanel.jsx';
import { Settings as SettingsIcon } from 'lucide-react';

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="min-h-screen bg-gray-50">
      <button
        aria-label={settingsOpen ? 'Hide settings' : 'Show settings'}
        onClick={() => setSettingsOpen((v) => !v)}
        className="fixed top-4 right-4 z-50 rounded-full p-3 bg-white shadow-lg border hover:bg-gray-50"
        title={settingsOpen ? 'Hide settings' : 'Show settings'}
      >
        <SettingsIcon className={settingsOpen ? 'text-blue-600' : 'text-gray-700'} size={20} />
      </button>
      <div className="py-6">
        <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className={settingsOpen ? 'lg:col-span-2' : 'lg:col-span-3'}>
            <SpanishPracticeApp />
          </div>
          {settingsOpen && (
            <div>
              <SettingsPanel />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


