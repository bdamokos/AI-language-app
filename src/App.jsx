import React, { useState, useEffect } from 'react';
import AIPracticeApp from './AIPracticeApp.jsx';
import SettingsPanel from './SettingsPanel.jsx';
import { Settings as SettingsIcon } from 'lucide-react';

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isProduction, setIsProduction] = useState(false);

  useEffect(() => {
    // Check if we're in production environment
    const checkProduction = () => {
      // Check NODE_ENV (set by Vite during build)
      const isProdEnv = import.meta.env.PROD;
      
      // Check hostname for production domain
      const isProdDomain = window.location.hostname === 'languages.bdamokos.org';
      
      setIsProduction(isProdEnv || isProdDomain);
    };
    
    checkProduction();
  }, []);

  // Don't render settings button in production
  if (isProduction) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="py-6">
          <div className="max-w-5xl mx-auto">
            <AIPracticeApp />
          </div>
        </div>
      </div>
    );
  }

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
            <AIPracticeApp />
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


