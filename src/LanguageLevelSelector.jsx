import React, { useState } from 'react';
import { Globe, GraduationCap, ArrowRight, Languages, BookOpen } from 'lucide-react';

const CEFR_LEVELS = [
  { value: 'A1', label: 'A1 - Beginner', description: 'Can understand and use familiar everyday expressions and very basic phrases' },
  { value: 'A2', label: 'A2 - Elementary', description: 'Can communicate in simple and routine tasks requiring simple information exchange' },
  { value: 'B1', label: 'B1 - Intermediate', description: 'Can deal with most situations likely to arise while traveling in an area where the language is spoken' },
  { value: 'B2', label: 'B2 - Upper Intermediate', description: 'Can interact with a degree of fluency and spontaneity that makes regular interaction with native speakers possible' },
  { value: 'C1', label: 'C1 - Advanced', description: 'Can express ideas fluently and spontaneously without much searching for expressions' },
  { value: 'C2', label: 'C2 - Mastery', description: 'Can understand with ease virtually everything heard or read' }
];

// Popular language suggestions for quick selection
const POPULAR_LANGUAGES = [
  { code: 'es', name: 'Spanish', flag: '🇪🇸' },
  { code: 'fr', name: 'French', flag: '🇫🇷' },
  { code: 'it', name: 'Italian', flag: '🇮🇹' },
  { code: 'hu', name: 'Hungarian', flag: '🇭🇺' }
];

export default function LanguageLevelSelector({ onStart, isLoading = false }) {
  const [selectedLanguage, setSelectedLanguage] = useState('es');
  const [selectedLevel, setSelectedLevel] = useState('B1');
  const [challengeMode, setChallengeMode] = useState(false);
  const [customLanguage, setCustomLanguage] = useState('');
  const [topic, setTopic] = useState('');
  const [strictAccents, setStrictAccents] = useState(true);
  const [showAccentBar, setShowAccentBar] = useState(false);

  const handleLanguageSelect = (languageCode) => {
    setSelectedLanguage(languageCode);
    setCustomLanguage('');
  };

  const handleCustomLanguageChange = (value) => {
    setCustomLanguage(value);
    setSelectedLanguage('custom');
  };

  const handleStart = () => {
    const finalLanguage = selectedLanguage === 'custom' ? customLanguage : 
      POPULAR_LANGUAGES.find(l => l.code === selectedLanguage)?.name || selectedLanguage;
    if (!finalLanguage.trim() || !topic.trim()) return;
    
    onStart({
      language: finalLanguage,
      level: selectedLevel,
      challengeMode,
      topic: topic.trim(),
      strictAccents,
      showAccentBar
    });
  };

  const canStart = (selectedLanguage === 'custom' && customLanguage.trim()) || 
                   (selectedLanguage && selectedLanguage !== 'custom');
  const canProceed = canStart && topic.trim();

  const selectedLevelInfo = CEFR_LEVELS.find(level => level.value === selectedLevel);

  return (
    <div id="language-selector-root" className="max-w-4xl mx-auto p-6 bg-white rounded-lg shadow-lg">
      <div className="text-center mb-8">
        <div className="flex justify-center mb-4">
          <div className="p-3 bg-blue-100 rounded-full">
            <Globe className="text-blue-600" size={32} />
          </div>
        </div>
        <h1 className="text-3xl font-bold text-gray-800 mb-2">
          Language Learning with AI
        </h1>
        <p className="text-gray-600 text-lg">
          Choose your target language, proficiency level, and topic to get started
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Language Selection */}
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <Languages className="text-blue-600" size={20} />
            <h2 className="text-xl font-semibold text-gray-800">Target Language</h2>
          </div>
          
          {/* Popular Languages Grid */}
          <div id="popular-languages" className="mb-4">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Popular Languages</h3>
            <div className="grid grid-cols-2 gap-2">
              {POPULAR_LANGUAGES.map((language) => (
                <button
                  key={language.code}
                  onClick={() => handleLanguageSelect(language.code)}
                  className={`p-3 border-2 rounded-lg text-left transition-all hover:shadow-md ${
                    selectedLanguage === language.code
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xl">{language.flag}</span>
                    <span className="font-medium text-gray-800">{language.name}</span>
                    {selectedLanguage === language.code && (
                      <div className="w-3 h-3 bg-blue-500 rounded-full ml-auto"></div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Custom Language Input */}
          <div id="custom-language" className="border-t pt-4">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Or Enter Any Language</h3>
            <div className="space-y-3">
              <input
                id="custom-language-input"
                type="text"
                value={customLanguage}
                onChange={(e) => handleCustomLanguageChange(e.target.value)}
                placeholder="e.g., Swahili, Arabic, Hindi, Swedish..."
                className={`w-full px-4 py-3 border-2 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all ${
                  selectedLanguage === 'custom' && customLanguage.trim()
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              />
              {customLanguage.trim() && (
                <div className="flex items-center gap-2 text-sm text-blue-600">
                  <div className="w-3 h-3 bg-blue-500 rounded-full"></div>
                  <span>Custom language: <strong>{customLanguage}</strong></span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Level Selection */}
        <div id="level-selection" className="space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <GraduationCap className="text-green-600" size={20} />
            <h2 className="text-xl font-semibold text-gray-800">Proficiency Level</h2>
          </div>
          
          <div className="space-y-3">
            {CEFR_LEVELS.map((level) => (
              <button
                key={level.value}
                onClick={() => setSelectedLevel(level.value)}
                className={`p-4 border-2 rounded-lg text-left transition-all hover:shadow-md ${
                  selectedLevel === level.value
                    ? 'border-green-500 bg-green-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="font-semibold text-gray-800">{level.label}</div>
                    <div className="text-sm text-gray-600">{level.description}</div>
                  </div>
                  {selectedLevel === level.value && (
                    <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                  )}
                </div>
              </button>
            ))}
          </div>

          {/* Challenge Mode Toggle */}
          <div id="challenge-mode" className="mt-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="challengeMode"
                checked={challengeMode}
                onChange={(e) => setChallengeMode(e.target.checked)}
                className="h-4 w-4 text-amber-600 focus:ring-amber-500 border-amber-300 rounded"
              />
              <label htmlFor="challengeMode" className="text-sm font-medium text-amber-800">
                Challenge Mode
              </label>
            </div>
            <p className="text-xs text-amber-700 mt-1 ml-7">
              When enabled, exercises will be slightly more challenging than your selected level to help you grow
            </p>
          </div>
        </div>
      </div>

      {/* Accent Settings */}
      <div className="mt-6 p-4 bg-gray-50 border border-gray-200 rounded-lg">
        <h3 className="text-sm font-medium text-gray-700 mb-3">Accent Settings</h3>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="strictAccents"
              checked={strictAccents}
              onChange={(e) => setStrictAccents(e.target.checked)}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
            />
            <label htmlFor="strictAccents" className="text-sm text-gray-700">
              Strict accent checking (á ≠ a)
            </label>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="showAccentBar"
              checked={showAccentBar}
              onChange={(e) => setShowAccentBar(e.target.checked)}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
            />
            <label htmlFor="showAccentBar" className="text-sm text-gray-700">
              Show accent toolbar
            </label>
          </div>
        </div>
      </div>

      {/* Topic Input - Full Width */}
      <div id="topic-section" className="mt-8 border-t pt-6">
        <div className="flex items-center gap-2 mb-4">
          <BookOpen className="text-purple-600" size={20} />
          <h2 className="text-xl font-semibold text-gray-800">What would you like to practice?</h2>
        </div>
        <div className="space-y-3">
          <input
            id="topic-input"
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && canProceed && handleStart()}
            placeholder="e.g., present tense conjugation, past tense of irregular verbs, subjunctive mood..."
            className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all hover:border-gray-300"
          />
          <p className="text-sm text-gray-500">
            Be specific! Examples: "ser vs estar", "preterite tense", "reflexive verbs", "conditional mood"
          </p>
        </div>
      </div>

      {/* Summary and Start Button */}
      <div className="mt-8 p-6 bg-gray-50 rounded-lg">
        <div className="text-center mb-4">
          <h3 className="text-lg font-semibold text-gray-800 mb-2">Ready to Start?</h3>
          <div className="flex items-center justify-center gap-4 text-sm text-gray-600">
            <span className="flex items-center gap-2">
              <Globe className="text-blue-600" size={16} />
              {selectedLanguage === 'custom' ? customLanguage : 
               POPULAR_LANGUAGES.find(l => l.code === selectedLanguage)?.name || 'Select Language'}
            </span>
            <span className="text-gray-400">•</span>
            <span className="flex items-center gap-2">
              <GraduationCap size={16} />
              {selectedLevelInfo?.label}
            </span>
            {challengeMode && (
              <>
                <span className="text-gray-400">•</span>
                <span className="text-amber-600 font-medium">Challenge Mode</span>
              </>
            )}
            {topic.trim() && (
              <>
                <span className="text-gray-400">•</span>
                <span className="text-purple-600 font-medium">"{topic}"</span>
              </>
            )}
          </div>
        </div>
        
        <button
          id="start-lesson-button"
          onClick={handleStart}
          disabled={isLoading || !canProceed}
          className="w-full bg-blue-600 text-white py-3 px-6 rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 text-lg font-medium"
        >
          {isLoading ? (
            <>
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
              Generating Lesson...
            </>
          ) : (
            <>
              Start Learning
              <ArrowRight size={20} />
            </>
          )}
        </button>
      </div>
    </div>
  );
}
